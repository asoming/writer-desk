"""Bounded Chat Completions SSE transport with conservative compatibility.

Only a provider explicitly rejecting the stream parameter is retried. Network
failures and interrupted streams never automatically repeat a paid request.
"""
import json
import threading
import urllib.error
import urllib.request


class ReplyPreview:
    """Expose only the top-level envelope reply, never partial JSON candidates."""
    def __init__(self):
        self.raw = ""
        self.shown = ""
        self.done = False

    def feed(self, fragment):
        if self.done:
            return ""
        self.raw += fragment
        raw = self.raw.lstrip()
        if raw.startswith("```json"):
            raw = raw[7:].lstrip()
        if not raw.startswith("{"):
            return ""
        decoder, offset = json.JSONDecoder(), 1
        while offset < len(raw):
            while offset < len(raw) and raw[offset] in " \t\r\n,":
                offset += 1
            try:
                key, end = decoder.raw_decode(raw, offset)
            except ValueError:
                return ""
            offset = end
            while offset < len(raw) and raw[offset].isspace():
                offset += 1
            if offset >= len(raw) or raw[offset] != ":":
                return ""
            offset += 1
            while offset < len(raw) and raw[offset].isspace():
                offset += 1
            if key == "reply":
                if offset >= len(raw) or raw[offset] != '"':
                    return ""
                text, cursor = [], offset + 1
                while cursor < len(raw):
                    char = raw[cursor]
                    if char == '"':
                        self.done = True
                        break
                    if char != "\\":
                        if ord(char) < 32:
                            return ""
                        text.append(char)
                        cursor += 1
                        continue
                    start = cursor
                    if cursor + 1 >= len(raw):
                        break
                    escape = raw[cursor + 1]
                    cursor += 6 if escape == "u" else 2
                    if cursor > len(raw):
                        break
                    encoded = raw[start:cursor]
                    try:
                        decoded = json.loads('"' + encoded + '"')
                        if len(decoded) == 1 and 0xD800 <= ord(decoded) <= 0xDBFF:
                            if cursor + 6 > len(raw):
                                break
                            encoded += raw[cursor:cursor + 6]
                            decoded = json.loads('"' + encoded + '"')
                            cursor += 6
                        if any(0xD800 <= ord(value) <= 0xDFFF for value in decoded):
                            return ""
                        text.append(decoded)
                    except ValueError:
                        return ""
                value = "".join(text)
                if not value.startswith(self.shown):
                    return ""
                delta = value[len(self.shown):]
                self.shown = value
                return delta
            try:
                _, offset = decoder.raw_decode(raw, offset)
            except ValueError:
                return ""
        return ""


def request_stream(service, settings, messages, on_delta, cancelled, *, with_images=False):
    from ai_service import AIError, _NoRedirect, _compact, _context_rejected, CONTEXT_ERROR_MESSAGE, MAX_CHAT_RESPONSE_BYTES, MAX_RESPONSE_BYTES, MAX_OUTPUT_CHARS
    limit = MAX_CHAT_RESPONSE_BYTES if with_images else MAX_RESPONSE_BYTES
    stopped = cancelled or (lambda: False)

    def check():
        if stopped():
            raise AIError(499, "已停止生成。")

    check()
    headers = {"Content-Type": "application/json", "Accept": "text/event-stream, application/json"}
    if settings.get("apiKey"):
        headers["Authorization"] = "Bearer " + settings["apiKey"]
    payload = {"model": settings["model"], "messages": messages, "stream": True}
    request = urllib.request.Request(settings["endpoint"], data=_compact(payload).encode("utf-8"), headers=headers, method="POST")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    try:
        with opener.open(request, timeout=settings["timeoutSeconds"]) as response:
            check()
            if response.headers.get_content_type() != "text/event-stream":
                raw = response.read(limit + 1)
                check()
                if len(raw) > limit:
                    raise AIError(502, "AI 返回内容过大，请减少生成范围后重试。")
                result = json.loads(raw.decode("utf-8"))
                if _context_rejected(result):
                    raise AIError(400, CONTEXT_ERROR_MESSAGE)
                decoded = service._decode_response(result, with_images=with_images)
                fragment = decoded["content"] if with_images else decoded
                preview = ReplyPreview()
                delta = preview.feed(fragment) if with_images else fragment
                if delta:
                    on_delta(delta)
                return decoded
            content, images, total, content_chars, event, finished, reason = [], [], 0, 0, [], False, None
            preview = ReplyPreview()

            def consume():
                nonlocal finished, reason, content_chars
                if not event:
                    return
                value = "\n".join(event)
                event.clear()
                if value == "[DONE]":
                    finished = True
                    return
                data = json.loads(value)
                if _context_rejected(data):
                    raise AIError(400, CONTEXT_ERROR_MESSAGE)
                if not isinstance(data, dict) or data.get("error"):
                    raise AIError(502, "AI 流式请求失败，请检查配置后重试。")
                choices = data.get("choices")
                if choices == []:  # Usage-only events are permitted.
                    return
                if not isinstance(choices, list) or len(choices) != 1 or not isinstance(choices[0], dict):
                    raise ValueError("invalid stream choice")
                choice = choices[0]
                if choice.get("index", 0) != 0:
                    raise ValueError("unexpected choice")
                delta = choice.get("delta", {})
                if not isinstance(delta, dict):
                    raise ValueError("invalid stream delta")
                fragment = delta.get("content", "")
                if fragment is None:
                    fragment = ""
                if isinstance(fragment, list) and with_images:
                    texts = []
                    for part in fragment:
                        if not isinstance(part, dict):
                            raise ValueError("invalid content part")
                        if part.get("type") == "text" and isinstance(part.get("text"), str):
                            texts.append(part["text"])
                        elif part.get("type") in {"image", "image_url"}:
                            images.append(part)
                        else:
                            raise ValueError("unsupported content part")
                    fragment = "".join(texts)
                if not isinstance(fragment, str):
                    raise ValueError("invalid stream text")
                if fragment:
                    content.append(fragment)
                    content_chars += len(fragment)
                    if content_chars > (MAX_CHAT_RESPONSE_BYTES if with_images else MAX_OUTPUT_CHARS):
                        raise AIError(502, "AI 返回内容过大，请减少生成范围后重试。")
                    visible = preview.feed(fragment) if with_images else fragment
                    if visible:
                        check()
                        on_delta(visible)
                if "images" in delta:
                    if isinstance(delta["images"], list):
                        images.extend(delta["images"])
                    else:
                        images.append({"invalid": True})
                if choice.get("finish_reason") is not None:
                    reason = choice["finish_reason"]
                    if reason not in {"stop", "length"}:
                        raise AIError(502, "AI 未返回完整文本，请调整要求后重试。")

            # Closing a response on cancellation interrupts readline even if a
            # provider stalls between tokens. No disk writes occur in this thread.
            watcher_done = threading.Event()
            def watch():
                while not watcher_done.wait(0.15):
                    if stopped():
                        response.close()
                        return
            watcher = threading.Thread(target=watch, daemon=True)
            watcher.start()
            try:
                while not finished:
                    check()
                    raw = response.readline(limit + 1)
                    check()
                    if not raw:
                        break
                    total += len(raw)
                    if total > limit:
                        raise AIError(502, "AI 返回内容过大，请减少生成范围后重试。")
                    line = raw.decode("utf-8").rstrip("\r\n")
                    if not line:
                        consume()
                    elif line.startswith("data:"):
                        event.append(line[5:].lstrip(" "))
                if event:
                    consume()
                # A proper finish reason is required; EOF/[DONE] alone must
                # never turn a partial candidate into a completed manuscript.
                if reason is None:
                    raise AIError(502, "AI 流式连接中断，请重试。")
                check()
                result = {"choices": [{"finish_reason": reason, "message": {"content": "".join(content), **({"images": images} if images else {})}}]}
                return service._decode_response(result, with_images=with_images)
            finally:
                watcher_done.set()
    except AIError:
        raise
    except urllib.error.HTTPError as error:
        try:
            raw = error.read(65537)
            failure = json.loads(raw.decode("utf-8")) if len(raw) <= 65536 else None
        except (OSError, ValueError, UnicodeError):
            failure = None
        finally:
            error.close()
        check()
        if _context_rejected(failure):
            raise AIError(400, CONTEXT_ERROR_MESSAGE) from None
        detail = failure.get("error") if isinstance(failure, dict) else None
        unsupported = isinstance(detail, dict) and detail.get("param") == "stream" and detail.get("code") in {"unsupported_parameter", "unsupported_value", "not_supported"}
        if error.code in {400, 422} and unsupported:
            result = service._request(settings, messages, with_images=with_images)
            check()
            fragment = result["content"] if with_images else result
            delta = ReplyPreview().feed(fragment) if with_images else fragment
            if delta:
                on_delta(delta)
            return result
        if 300 <= error.code < 400:
            raise AIError(502, "AI 服务要求重定向，已停止请求。请填写最终服务地址。") from None
        raise AIError(502, "AI 服务请求失败（HTTP " + str(error.code) + "）。请检查配置后重试。") from None
    except (TimeoutError, OSError, urllib.error.URLError):
        check()
        raise AIError(502, "AI 服务连接失败或超时，请检查地址后重试。") from None
    except (ValueError, UnicodeError, KeyError, IndexError, TypeError, AttributeError):
        check()
        raise AIError(502, "AI 流式返回格式无效，请检查服务是否兼容 Chat Completions。") from None
