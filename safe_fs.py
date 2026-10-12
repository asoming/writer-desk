"""Descriptor-relative owned storage on POSIX and pinned Win32 directories.

Windows does not implement Python's dir_fd APIs. Its native directory handles
are opened without FILE_SHARE_DELETE, which pins every ancestor against rename,
replacement or junction insertion until the child operation has completed.
Directory write sharing is also denied, blocking in-place reparse mutation.
FILE_FLAG_OPEN_REPARSE_POINT rejects links rather than traversing them. Only one
validated component is ever joined beneath a pinned parent; there is no unsafe
check-then-open pathname fallback. POSIX callers retain the standard os APIs.
"""
import errno
import os as _os


def __getattr__(name):
    return getattr(_os, name)


def _close_pinned_descriptor(descriptor, closer, parents):
    # Remove ownership while the CRT descriptor is still open. Closing it can
    # immediately let another thread reuse this integer for a different file.
    parent = parents.pop(descriptor, None)
    try:
        closer(descriptor)
    finally:
        if parent is not None:
            parent._release()


class _PinnedFile:
    def __init__(self, stream, parent):
        self._stream, self._parent = stream, parent

    def _release(self):
        parent, self._parent = self._parent, None
        if parent is not None:
            parent._release()

    def __getattr__(self, name):
        return getattr(self._stream, name)

    def __iter__(self):
        return iter(self._stream)

    def __enter__(self):
        self._stream.__enter__()
        return self

    def __exit__(self, *args):
        try:
            return self._stream.__exit__(*args)
        finally:
            self._release()

    def close(self):
        try:
            self._stream.close()
        finally:
            self._release()

    def __del__(self):
        self.close()


def _pin_stream(stream, descriptor, parents):
    # The wrapper owns this exact parent object, never a reusable descriptor ID.
    parent = parents.pop(descriptor, None)
    return _PinnedFile(stream, parent) if parent is not None else stream


if _os.name == "nt":
    import ctypes
    from ctypes import wintypes
    import msvcrt
    from pathlib import Path

    _kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    _INVALID = ctypes.c_void_p(-1).value
    _READ, _WRITE, _READ_ATTRIBUTES = 0x80000000, 0x40000000, 0x80
    _SHARE_READ, _SHARE_WRITE = 1, 2
    _OPEN_EXISTING, _OPEN_ALWAYS, _CREATE_NEW = 3, 4, 1
    _BACKUP_SEMANTICS, _OPEN_REPARSE = 0x02000000, 0x00200000
    _DIRECTORY, _REPARSE = 0x10, 0x400
    # These are private marker bits, never sent to a CRT or Win32 flag argument.
    O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK = 1 << 28, 1 << 29, 1 << 30

    class _FileInfo(ctypes.Structure):
        _fields_ = [("attributes", wintypes.DWORD), ("creation", wintypes.FILETIME),
                    ("access", wintypes.FILETIME), ("write", wintypes.FILETIME),
                    ("volume", wintypes.DWORD), ("size_high", wintypes.DWORD),
                    ("size_low", wintypes.DWORD), ("links", wintypes.DWORD),
                    ("index_high", wintypes.DWORD), ("index_low", wintypes.DWORD)]

    _kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                   wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    _kernel.CreateFileW.restype = wintypes.HANDLE
    _kernel.CloseHandle.argtypes, _kernel.CloseHandle.restype = [wintypes.HANDLE], wintypes.BOOL
    _kernel.GetFileInformationByHandle.argtypes = [wintypes.HANDLE, ctypes.POINTER(_FileInfo)]
    _kernel.GetFileInformationByHandle.restype = wintypes.BOOL
    _kernel.FlushFileBuffers.argtypes, _kernel.FlushFileBuffers.restype = [wintypes.HANDLE], wintypes.BOOL
    _kernel.MoveFileExW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD]
    _kernel.MoveFileExW.restype = wintypes.BOOL
    _kernel.CreateHardLinkW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.LPVOID]
    _kernel.CreateHardLinkW.restype = wintypes.BOOL

    def _error(path):
        code = ctypes.get_last_error()
        # Match Python's path-based exceptions, which callers already handle.
        kinds = {2: FileNotFoundError, 3: FileNotFoundError, 5: PermissionError,
                 32: PermissionError, 80: FileExistsError, 183: FileExistsError,
                 267: NotADirectoryError}
        numbers = {2: errno.ENOENT, 3: errno.ENOENT, 5: errno.EACCES,
                   32: errno.EACCES, 80: errno.EEXIST, 183: errno.EEXIST, 267: errno.ENOTDIR}
        error = kinds.get(code, OSError)(numbers.get(code, errno.EIO), ctypes.FormatError(code), str(path))
        error.winerror = code
        raise error

    def _unsafe(path):
        raise OSError(errno.ELOOP, "Reparse points are not allowed in owned storage", str(path))

    def _extended(path):
        path = str(path)
        if path.startswith("\\\\?\\"):
            return path
        if path.startswith("\\\\"):
            return "\\\\?\\UNC\\" + path[2:]
        return "\\\\?\\" + path

    def _component(name):
        name = _os.fspath(name)
        if (not isinstance(name, str) or not name or name in (".", "..")
                or any(char in name for char in "\\/:\0") or name[-1] in " ."
                or any(ord(char) < 32 for char in name)):
            raise ValueError("Expected a single safe path component")
        stem = name.split(".", 1)[0].upper()
        if stem in {"CON", "PRN", "AUX", "NUL", *("COM" + str(i) for i in range(1, 10)),
                    *("LPT" + str(i) for i in range(1, 10))}:
            raise ValueError("Device names are not allowed in owned storage")
        return name

    class _DirectoryHandle:
        def __init__(self, path, handle, parent=None):
            self.path, self.handle, self.parent, self.references = path, handle, parent, 1
            if parent is not None:
                parent._retain()

        def _retain(self):
            if not self.handle:
                raise OSError(errno.EBADF, "Closed directory handle")
            self.references += 1

        def _release(self):
            if not self.handle:
                raise OSError(errno.EBADF, "Closed directory handle")
            self.references -= 1
            if self.references == 0:
                handle, self.handle = self.handle, None
                _kernel.CloseHandle(handle)
                if self.parent is not None:
                    self.parent._release()

    def _directory(value):
        if not isinstance(value, _DirectoryHandle) or not value.handle:
            raise OSError(errno.EBADF, "A pinned directory handle is required")
        return value

    def _child(directory, name):
        return _os.path.join(_directory(directory).path, _component(name))

    def _info(handle, path):
        info = _FileInfo()
        if not _kernel.GetFileInformationByHandle(handle, ctypes.byref(info)):
            _error(path)
        if info.attributes & _REPARSE:
            _unsafe(path)
        return info

    def _one_directory(path, parent=None):
        # Omitting FILE_SHARE_DELETE pins both directories and junction objects.
        handle = _kernel.CreateFileW(_extended(path), _READ_ATTRIBUTES, _SHARE_READ,
                                     None, _OPEN_EXISTING, _BACKUP_SEMANTICS | _OPEN_REPARSE, None)
        if handle == _INVALID:
            _error(path)
        try:
            if not _info(handle, path).attributes & _DIRECTORY:
                raise NotADirectoryError(errno.ENOTDIR, "Not a directory", str(path))
            return _DirectoryHandle(path, handle, parent)
        except BaseException:
            _kernel.CloseHandle(handle)
            raise

    def _open_directory(path, parent=None):
        if parent is not None:
            return _one_directory(_child(parent, path), parent)
        absolute = _os.path.abspath(_os.fspath(path))
        parts = Path(absolute).parts
        if not parts or not Path(absolute).is_absolute():
            raise ValueError("An absolute storage directory is required")
        current = _one_directory(parts[0])
        try:
            for part in parts[1:]:
                following = _one_directory(_child(current, part), current)
                current._release()
                current = following
            return current
        except BaseException:
            current._release()
            raise

    _file_parents = {}

    def open(path, flags, mode=0o777, *, dir_fd=None):
        if flags & O_DIRECTORY:
            return _open_directory(path, dir_fd)
        parent = None
        if dir_fd is not None:
            parent = _directory(dir_fd)
            filename = _child(parent, path)
            parent._retain()
        else:
            filename = _os.path.abspath(_os.fspath(path))
            basename = _component(_os.path.basename(filename))
            parent = _open_directory(_os.path.dirname(filename))
            filename = _child(parent, basename)
        writable = bool(flags & (_os.O_WRONLY | _os.O_RDWR))
        access = _READ_ATTRIBUTES | (_WRITE if writable else _READ)
        if flags & _os.O_RDWR:
            access |= _READ
        disposition = (_CREATE_NEW if flags & _os.O_EXCL else _OPEN_ALWAYS) if flags & _os.O_CREAT else _OPEN_EXISTING
        handle = None
        try:
            handle = _kernel.CreateFileW(_extended(filename), access, _SHARE_READ,
                                         None, disposition, _OPEN_REPARSE, None)
            if handle == _INVALID:
                handle = None
                _error(filename)
            info = _info(handle, filename)
            if info.attributes & _DIRECTORY:
                raise IsADirectoryError(errno.EISDIR, "Expected a regular storage file", filename)
            crt_flags = flags & (_os.O_RDONLY | _os.O_WRONLY | _os.O_RDWR | _os.O_APPEND)
            crt_flags |= _os.O_BINARY | _os.O_NOINHERIT
            descriptor = msvcrt.open_osfhandle(handle, crt_flags)
            handle = None  # Ownership has transferred to the CRT descriptor.
            try:
                if flags & _os.O_TRUNC:
                    _os.ftruncate(descriptor, 0)
                _file_parents[descriptor], parent = parent, None
                return descriptor
            except BaseException:
                _os.close(descriptor)
                raise
        finally:
            if handle is not None:
                _kernel.CloseHandle(handle)
            if parent is not None:
                parent._release()

    supports_dir_fd = {open}

    def close(descriptor):
        if isinstance(descriptor, _DirectoryHandle):
            descriptor._release()
        else:
            _close_pinned_descriptor(descriptor, _os.close, _file_parents)

    def fdopen(descriptor, *args, **kwargs):
        stream = _os.fdopen(descriptor, *args, **kwargs)
        return _pin_stream(stream, descriptor, _file_parents) if kwargs.get("closefd", True) else stream

    def fstat(descriptor):
        if isinstance(descriptor, _DirectoryHandle):
            _directory(descriptor)
            return _os.stat(descriptor.path, follow_symlinks=False)
        return _os.fstat(descriptor)

    def fsync(descriptor):
        if isinstance(descriptor, _DirectoryHandle):
            if not _kernel.FlushFileBuffers(_directory(descriptor).handle):
                # Windows filesystems generally do not expose directory fsync.
                # File data is flushed before our WRITE_THROUGH rename instead.
                if ctypes.get_last_error() not in (1, 5, 6):
                    _error(descriptor.path)
        else:
            _os.fsync(descriptor)

    def listdir(path="."):
        return _os.listdir(_directory(path).path if isinstance(path, _DirectoryHandle) else path)

    def mkdir(path, mode=0o777, *, dir_fd=None):
        return _os.mkdir(_child(dir_fd, path) if dir_fd is not None else path, mode)

    def stat(path, *, dir_fd=None, follow_symlinks=True):
        return _os.stat(_child(dir_fd, path) if dir_fd is not None else path, follow_symlinks=follow_symlinks)

    def unlink(path, *, dir_fd=None):
        # DeleteFile removes the link object itself, never its target.
        return _os.unlink(_child(dir_fd, path) if dir_fd is not None else path)

    def replace(src, dst, *, src_dir_fd=None, dst_dir_fd=None):
        source = _child(src_dir_fd, src) if src_dir_fd is not None else _os.path.abspath(src)
        destination = _child(dst_dir_fd, dst) if dst_dir_fd is not None else _os.path.abspath(dst)
        if not _kernel.MoveFileExW(_extended(source), _extended(destination), 1 | 8):
            _error(destination)

    def link(src, dst, *, src_dir_fd=None, dst_dir_fd=None, follow_symlinks=True):
        source = _child(src_dir_fd, src) if src_dir_fd is not None else _os.path.abspath(src)
        destination = _child(dst_dir_fd, dst) if dst_dir_fd is not None else _os.path.abspath(dst)
        # Hold the source against swapping while CreateHardLink resolves it.
        descriptor = open(src if src_dir_fd is not None else source, _os.O_RDONLY, dir_fd=src_dir_fd)
        try:
            if not _kernel.CreateHardLinkW(_extended(destination), _extended(source), None):
                _error(destination)
        finally:
            close(descriptor)
