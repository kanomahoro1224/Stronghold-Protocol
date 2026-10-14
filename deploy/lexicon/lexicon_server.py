#!/usr/bin/env python3
"""Sensitive-lexicon `/contains` 服务的最小零依赖实现。

用途：本仓库 `server/nameModeration.js` 的 `lexicon` 模式需要一个只监听回环、无鉴权的
HTTP 词库服务，契约见 `docs/NAME_MODERATION.md`：

    GET  /health              -> {"status": "ok", "count": N}
    POST /contains {"text":…} -> {"contains": true, "word": "命中词"} 或 {"contains": false}
    POST /reload              -> {"count": N}

上游 `konsheng/Sensitive-lexicon` 钉住的提交 `b05a333e0747d39c86bc2375a8af7b5b24c4fa08`
是一个 Go(Fiber) 服务，行为等价于本文件（`internal/lexicon/store.go`）：

* 词库：递归读取 `LEXICON_DIR` 下所有 `.txt`，逐行 `TrimSpace`，跳过空行与 `#` 开头的注释；
* 匹配：**大小写不敏感**的子串匹配，按输入的第一个字符位置从前往后扫描，命中即返回；
* 因此 `contains` 为真等价于“存在某个词条是输入文本的子串”。

生产机（2026-10-14）没有 docker、没有 Go、没有 pip，所以用本文件直接跑，词表仍用上述
提交的真实词库。若以后改用上游 Go 二进制，只需保持同样的端口与契约，本仓库配置不用改。
"""

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY_BYTES = 8192
DEFAULT_DIR = "Vocabulary"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = "8080"


class Lexicon:
    """已加载的词表。热重载时整体换掉集合，读请求持锁时间极短。"""

    def __init__(self, directory):
        self.directory = directory
        self._lock = threading.Lock()
        self._words = frozenset()
        self._count = 0
        self.reload()

    def reload(self):
        words = set()
        for root, _dirs, names in os.walk(self.directory):
            for name in names:
                if not name.lower().endswith(".txt"):
                    continue
                path = os.path.join(root, name)
                try:
                    with open(path, "r", encoding="utf-8", errors="ignore") as handle:
                        for line in handle:
                            word = line.strip()
                            if not word or word.startswith("#"):
                                continue
                            words.add(word.lower())
                except OSError as err:
                    print(f"[lexicon] 跳过 {path}: {err}", file=sys.stderr, flush=True)
        if not words:
            raise RuntimeError(f"no entries loaded from {self.directory}")
        with self._lock:
            self._words = frozenset(words)
            self._count = len(words)
        return self._count

    @property
    def count(self):
        with self._lock:
            return self._count

    def contains(self, text):
        """返回最早命中的词条，没有则返回 None。与上游 HasAnyInText 的扫描顺序一致。"""
        needle = text.strip().lower()
        if not needle:
            return None
        with self._lock:
            words = self._words
        n = len(needle)
        for start in range(n):
            # 以 start 开头、长度递增地试，命中即返回该位置最短的词条。
            for end in range(start + 1, n + 1):
                candidate = needle[start:end]
                if candidate in words:
                    return candidate
        return None


class Handler(BaseHTTPRequestHandler):
    server_version = "sensitive-lexicon-py"
    protocol_version = "HTTP/1.1"
    lexicon = None

    def _send(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None
        if length <= 0 or length > MAX_BODY_BYTES:
            return None
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None

    def do_GET(self):
        if self.path.split("?")[0] == "/health":
            self._send(200, {"status": "ok", "count": self.lexicon.count})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/contains":
            data = self._read_json()
            if not isinstance(data, dict) or not isinstance(data.get("text"), str):
                self._send(400, {"error": "text must be a string"})
                return
            word = self.lexicon.contains(data["text"])
            # 与上游 ContainsResponse 的 omitempty 一致：未命中时不带 word 字段。
            self._send(200, {"contains": bool(word), **({"word": word} if word else {})})
        elif path == "/reload":
            try:
                count = self.lexicon.reload()
            except RuntimeError as err:
                self._send(500, {"error": str(err)})
                return
            self._send(200, {"count": count})
        else:
            self._send(404, {"error": "not found"})

    def log_message(self, fmt, *args):  # 只记路径，不记请求正文或昵称
        sys.stderr.write("[lexicon] %s\n" % (fmt % args))
        sys.stderr.flush()


def main():
    directory = os.environ.get("LEXICON_DIR") or DEFAULT_DIR
    host = os.environ.get("HOST") or DEFAULT_HOST
    port = int(os.environ.get("PORT") or DEFAULT_PORT)
    lexicon = Lexicon(directory)
    Handler.lexicon = lexicon
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"[lexicon] {lexicon.count} 条词表，监听 {host}:{port}（{directory}）", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
