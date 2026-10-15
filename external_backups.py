"""A second, user-selected backup destination with an owned namespace.

The ordinary local snapshots always remain enabled independently. No authored
files outside this namespace are overwritten or removed.
"""
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import safe_fs as os
from pathlib import Path
import stat
import time
import uuid
import protection

MARKER = '.writer-desk-owner.json'
WARNING = '本机保存和备份已保留，但外部备份位置不可用，请连接备份盘后重试。'


def initialize(conn):
    conn.execute('CREATE TABLE IF NOT EXISTS external_backup_settings(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL)')
    conn.execute('CREATE TABLE IF NOT EXISTS external_backup_runs(destination TEXT NOT NULL,book_id TEXT NOT NULL,last_success REAL NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(destination,book_id))')
    if not conn.execute('SELECT 1 FROM external_backup_settings WHERE id=1').fetchone():
        value = {'version': 1, 'libraryId': uuid.uuid4().hex, 'enabled': False,
                 'destination': '', 'locations': []}
        conn.execute('INSERT INTO external_backup_settings VALUES(1,?)', (json.dumps(value),))


def settings(conn):
    value = json.loads(conn.execute('SELECT payload FROM external_backup_settings WHERE id=1').fetchone()[0])
    public = {key: value[key] for key in ('enabled', 'destination', 'locations')}
    row = conn.execute('SELECT MAX(last_success) FROM external_backup_runs').fetchone()
    public['lastSuccess'] = datetime.fromtimestamp(row[0], timezone.utc).isoformat() if row and row[0] else None
    return public


def config(conn):
    return json.loads(conn.execute('SELECT payload FROM external_backup_settings WHERE id=1').fetchone()[0])


@contextmanager
def walk_directory(directory):
    path = Path(os.path.abspath(directory))
    flags, descriptors = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, []
    try:
        current = os.open(path.anchor, flags); descriptors.append(current)
        for component in path.parts[1:]:
            current = os.open(component, flags, dir_fd=current); descriptors.append(current)
        yield current
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


@contextmanager
def namespace(destination, library_id, create=False):
    if not isinstance(destination, str) or not destination or len(destination) > 4096 or not Path(destination).is_absolute():
        raise protection.ProtectionError('请选择已有的绝对路径备份文件夹')
    name = 'WriterDesk-Backups-' + library_id
    try:
        with walk_directory(destination) as parent:
            created = False
            if create:
                try:
                    os.mkdir(name, 0o700, dir_fd=parent); created = True
                except FileExistsError:
                    pass
            try:
                directory = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            except FileNotFoundError:
                if not create:
                    yield None; return
                raise
            try:
                if created:
                    fd = os.open(MARKER, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
                    with os.fdopen(fd, 'wb') as stream:
                        stream.write(json.dumps({'format': 'writer-desk-external-backup', 'libraryId': library_id}).encode())
                        stream.flush(); os.fsync(stream.fileno())
                    os.fsync(directory)
                fd = os.open(MARKER, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
                with os.fdopen(fd, 'rb') as stream:
                    info = os.fstat(stream.fileno())
                    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 1024:
                        raise ValueError('invalid owner marker')
                    marker = json.loads(stream.read(1025))
                if marker != {'format': 'writer-desk-external-backup', 'libraryId': library_id}:
                    raise ValueError('foreign backup directory')
                yield Path(destination) / name
            finally:
                os.close(directory)
    except (OSError, ValueError, TypeError) as error:
        raise protection.ProtectionError(WARNING, 503) from error


def configure(conn, value):
    if not isinstance(value, dict) or set(value) != {'enabled', 'destination'} or type(value['enabled']) is not bool:
        raise protection.ProtectionError('外部备份设置格式不正确')
    current = config(conn)
    destination = value['destination']
    if not isinstance(destination, str) or len(destination) > 4096:
        raise protection.ProtectionError('外部备份路径不正确')
    if destination:
        if not Path(destination).is_absolute():
            raise protection.ProtectionError('请选择已有的绝对路径备份文件夹')
        destination = os.path.abspath(destination)
        with namespace(destination, current['libraryId'], create=True):
            pass
        if destination not in current['locations']:
            if len(current['locations']) >= 100:
                raise protection.ProtectionError('外部备份位置数量已达上限')
            current['locations'].append(destination)
    elif value['enabled']:
        raise protection.ProtectionError('请先选择外部备份文件夹')
    current.update(enabled=value['enabled'], destination=destination)
    conn.execute('UPDATE external_backup_settings SET payload=? WHERE id=1', (json.dumps(current),))
    return settings(conn)


def checkpoint(conn, row, book, validate, force=False):
    current, policy, tick = config(conn), protection.settings(conn), time.time()
    if not current['enabled'] or not current['destination']:
        return None
    target = current['destination']
    previous = conn.execute('SELECT last_success,revision FROM external_backup_runs WHERE destination=? AND book_id=?', (target, book['id'])).fetchone()
    if not force and (not policy['enabled'] or previous and tick - previous[0] < policy['intervalMinutes'] * 60):
        return None
    stamp = datetime.now(timezone.utc).isoformat()
    token = 'r' + str(row['revision']) + '-' + uuid.uuid4().hex + '.json'
    value = {'format': 'yejian-backup', 'version': 4, 'exportedAt': stamp, 'book': book,
             'writerDeskSnapshot': {'bookId': book['id'], 'revision': row['revision'], 'createdAt': stamp, 'reason': 'external'}}
    payload = json.dumps(value, ensure_ascii=False, indent=2).encode() + b'\n'
    with namespace(target, current['libraryId'], create=True) as root:
        with protection.directory(root / 'library.sqlite3', book['id'], create=True) as directory:
            temporary = '.snapshot-' + uuid.uuid4().hex + '.tmp'
            try:
                fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
                with os.fdopen(fd, 'wb') as stream:
                    stream.write(payload); stream.flush(); os.fsync(stream.fileno())
                os.replace(temporary, token, src_dir_fd=directory, dst_dir_fd=directory); os.fsync(directory)
                for old in protection.entries(directory, book['id'], validate)[policy['retentionCount']:]:
                    os.unlink(old['token'], dir_fd=directory)
                os.fsync(directory)
            finally:
                try: os.unlink(temporary, dir_fd=directory)
                except FileNotFoundError: pass
    conn.execute('INSERT INTO external_backup_runs VALUES(?,?,?,?) ON CONFLICT(destination,book_id) DO UPDATE SET last_success=excluded.last_success,revision=excluded.revision', (target, book['id'], tick, row['revision']))
    return {'revision': row['revision'], 'savedAt': stamp, 'token': token}


def clean_book(conn, book_id, validate, sanitize=None):
    """Return False for an offline destination so the existing purge job retries."""
    current, complete = config(conn), True
    for destination in current['locations']:
        try:
            with namespace(destination, current['libraryId']) as root:
                if root is None: continue
                fake_database = root / 'library.sqlite3'
                if sanitize is None:
                    def empty(value):
                        return {'id': value['id'], 'title': value['title'], 'kind': value['kind'],
                                'volumes': [], 'chapters': [], 'notes': [], 'outline': [], 'relations': []}
                    # Existing strict rewrite also validates/crash-cleans owned
                    # temporary snapshots; unreadable owned files keep the job pending.
                    protection.rewrite_snapshots(fake_database, book_id, validate, empty)
                    protection.purge_snapshots(fake_database, book_id, validate)
                    conn.execute('DELETE FROM external_backup_runs WHERE destination=? AND book_id=?', (destination, book_id))
                else:
                    protection.rewrite_snapshots(fake_database, book_id, validate, sanitize)
        except (OSError, ValueError, protection.ProtectionError):
            complete = False
    return complete
