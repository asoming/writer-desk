"""HTTP streaming adapter; called only after the server's read_json guard.

serve(handler, path, data, server_context) returns whether it handled the route.
The context provides DB_PATH, DB_LOCK, connect, require_active_book, book_result,
short_chapter_ids and chapter_history, using the server's existing boundaries.
"""
from contextlib import contextmanager
import json
import queue
import re
import threading

from ai_service import AIService, AIError


def serve(handler, path, data, srv):
    match = re.fullmatch(r"/api/books/([^/]+)/ai/stream", path)
    if not match:
        return False
    allowed = {"action", "chapterIds", "instruction", "skillIds", "skillMode", "chat", "history", "model", "attachments"}
    if not isinstance(data, dict) or set(data) - allowed or data.get("chat") is not True:
        raise AIError(400, "流式对话参数不正确。")
    if any(key in data and data[key] is None for key in ("skillIds", "skillMode", "model")):
        raise AIError(400, "AI 写作参数不正确。")
    with srv.DB_LOCK, srv.connect() as conn:
        row = conn.execute("SELECT * FROM books WHERE id=?", (match[1],)).fetchone()
        if not row:
            raise AIError(404, "找不到这部作品")
        srv.require_active_book(row)
        generation = srv.chapter_history.purged_ids(conn, row["id"])
        if srv.chapter_history.image_cleanup_pending(conn, row["id"]):
            raise AIError(409, "本机副本清理尚未完成，请在历史记录中重试清理后再使用 AI。")
        book = srv.book_result(row)["book"]
    service = AIService(srv.DB_PATH.parent)
    arguments = (book, data.get("action"), srv.short_chapter_ids(book, data.get("chapterIds")), data.get("instruction", ""), data.get("skillIds"), data.get("skillMode"))
    keywords = {key: data.get(key) for key in ("history", "model", "attachments")}
    keywords["chat"] = True
    # Validate all author-controlled data before starting a response/provider.
    preview = service.preview(*arguments, **keywords)
    service._configured()
    if preview["overLimit"]:
        raise AIError(400, "所选资料超过上下文字符上限，请减少章节或调整设置；没有发送任何资料。")
    cancelled, events = threading.Event(), queue.Queue(maxsize=32)

    def guard():
        if cancelled.is_set():
            raise AIError(499, "已停止生成。")
        with srv.DB_LOCK, srv.connect() as conn:
            latest = conn.execute("SELECT * FROM books WHERE id=?", (book["id"],)).fetchone()
            if not latest:
                raise AIError(404, "找不到这部作品")
            if latest["deleted_at"] is not None:
                raise AIError(409, "作品已被回收，请返回书架。")
            if srv.chapter_history.purged_ids(conn, book["id"]) != generation:
                raise AIError(409, "作品内容已被彻底删除，请重新发起对话。")
            if srv.chapter_history.image_cleanup_pending(conn, book["id"]):
                raise AIError(409, "本机副本清理尚未完成，请在历史记录中重试清理。")

    @contextmanager
    def guard_images(book_id):
        # Keep the book lock across image persistence, as the non-stream route
        # does, so final purge cannot race a late provider image write.
        with srv.DB_LOCK:
            guard()
            yield
    service.chat_image_guard = guard_images

    def emit(value):
        while not cancelled.is_set():
            try:
                events.put(value, timeout=0.1)
                return
            except queue.Full:
                pass
        raise AIError(499, "已停止生成。")

    def generate():
        try:
            result = service.run(*arguments, **keywords, on_delta=lambda fragment: emit({"type": "delta", "text": fragment}), cancelled=cancelled.is_set)
            guard()
            emit({"type": "result", "result": result})
        except AIError as error:
            if not cancelled.is_set():
                emit({"type": "error", "error": error.message, "status": error.status})
        except Exception:
            if not cancelled.is_set():
                emit({"type": "error", "error": "AI 流式请求失败，请重试。", "status": 502})

    handler.send_response(200)
    handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("X-Content-Type-Options", "nosniff")
    handler.send_header("X-Accel-Buffering", "no")
    handler.send_header("Connection", "close")
    handler.end_headers()
    handler.close_connection = True
    worker = threading.Thread(target=generate, daemon=True)
    worker.start()
    try:
        while True:
            guard()
            try:
                event = events.get(timeout=0.4)
            except queue.Empty:
                handler.wfile.write(b": keep-alive\n\n")
                handler.wfile.flush()
                continue
            handler.wfile.write(("data: " + json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n\n").encode("utf-8"))
            handler.wfile.flush()
            if event["type"] in {"result", "error"}:
                break
    except AIError as error:
        try:
            handler.wfile.write(("data: " + json.dumps({"type": "error", "error": error.message, "status": error.status}, ensure_ascii=False) + "\n\n").encode("utf-8"))
            handler.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
    except (BrokenPipeError, ConnectionResetError, OSError):
        pass
    finally:
        cancelled.set()
    return True
