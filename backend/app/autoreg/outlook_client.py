"""
outlook_client.py - Получение писем из Outlook через локальный IMAP-прокси graph2imap.

graph2imap поднимается локально и превращает Microsoft Graph API в обычный
IMAP-сервер. Мы подключаемся к нему стандартным imaplib, логинимся почтой
Outlook и читаем INBOX так же, как читали бы любой IMAP-ящик.

Формат строки почты (как договорились):
    mail:pass:client_id:refresh_token

  * mail          - адрес ящика Outlook (он же IMAP-логин)
  * pass          - пароль ящика (на случай если прокси требует именно его)
  * client_id     - Azure app client_id для OAuth2 Graph
  * refresh_token - refresh_token для OAuth2 Graph

graph2imap (как и большинство Outlook->IMAP мостов) в команде LOGIN ждёт
OAuth-данные. По умолчанию мы отдаём refresh_token как IMAP-пароль; режим
можно переключить через IMAP_LOGIN_MODE, если твоя сборка graph2imap ждёт
другой формат.

Интерфейс класса полностью совпадает с прежним FirstMailClient:
    get_latest_message(email, password, folder)
    extract_6_digit_code(message)   (staticmethod)
    wait_for_code(email, password, folder, timeout_sec, poll_interval_sec, ignore_message_id)
"""

import email as email_lib
import imaplib
import re
import time
from email.header import decode_header, make_header
from typing import Optional


# ============================================================================
# Настройки подключения к локальному graph2imap
# ============================================================================
# graph2imap слушает локально. Меняй host/port/SSL под свою сборку.
IMAP_HOST = "127.0.0.1"
IMAP_PORT = 993
IMAP_USE_SSL = True

# Как формировать пароль для команды IMAP LOGIN:
#   "refresh_token"        -> login(email, refresh_token)
#   "client_id:refresh"    -> login(email, f"{client_id}:{refresh_token}")
#   "mailbox_password"     -> login(email, pass)          (если прокси сам хранит токены)
#   "xoauth2"              -> AUTHENTICATE XOAUTH2 access-string на базе refresh_token
IMAP_LOGIN_MODE = "refresh_token"


class OutlookClient:
    """
    Клиент Outlook через локальный IMAP-прокси graph2imap.

    Создаётся на один аккаунт: client_id / refresh_token принадлежат
    конкретному ящику Outlook.
    """

    def __init__(
        self,
        client_id: str = "",
        refresh_token: str = "",
        host: str = IMAP_HOST,
        port: int = IMAP_PORT,
        use_ssl: bool = IMAP_USE_SSL,
        login_mode: str = IMAP_LOGIN_MODE,
        timeout: float = 30.0,
    ):
        self.client_id = client_id or ""
        self.refresh_token = refresh_token or ""
        self.host = host
        self.port = port
        self.use_ssl = use_ssl
        self.login_mode = login_mode
        self.timeout = timeout

    # ----- внутреннее ------------------------------------------------------

    def _imap_password(self, mailbox_password: str) -> str:
        """Собирает строку, которую отдаём в IMAP LOGIN как пароль."""
        if self.login_mode == "client_id:refresh":
            return f"{self.client_id}:{self.refresh_token}"
        if self.login_mode == "mailbox_password":
            return mailbox_password or ""
        # по умолчанию - refresh_token
        return self.refresh_token or mailbox_password or ""

    def _connect(self):
        if self.use_ssl:
            imap = imaplib.IMAP4_SSL(self.host, self.port)
        else:
            imap = imaplib.IMAP4(self.host, self.port)
        return imap

    @staticmethod
    def _decode(value) -> str:
        if value is None:
            return ""
        try:
            return str(make_header(decode_header(value)))
        except Exception:
            return str(value)

    @staticmethod
    def _extract_body(msg) -> str:
        """Достаёт текстовое + html тело письма одной строкой."""
        chunks = []
        if msg.is_multipart():
            for part in msg.walk():
                ctype = part.get_content_type()
                if ctype in ("text/plain", "text/html"):
                    try:
                        payload = part.get_payload(decode=True)
                        if payload:
                            charset = part.get_content_charset() or "utf-8"
                            chunks.append(payload.decode(charset, errors="ignore"))
                    except Exception:
                        continue
        else:
            try:
                payload = msg.get_payload(decode=True)
                if payload:
                    charset = msg.get_content_charset() or "utf-8"
                    chunks.append(payload.decode(charset, errors="ignore"))
            except Exception:
                pass
        return "\n".join(chunks)

    # ----- публичный интерфейс (совместим с FirstMailClient) ---------------

    def get_latest_message(
        self,
        email: str,
        password: str,
        folder: str = "INBOX",
    ) -> Optional[dict]:
        """
        Возвращает последнее письмо из папки в виде dict с полями
        id / subject / body_text / body_html, либо None если писем нет.
        """
        imap = None
        try:
            imap = self._connect()
            imap.login(email, self._imap_password(password))
            status, _ = imap.select(folder)
            if status != "OK":
                print(f"[Outlook] не удалось открыть папку {folder}")
                return None

            status, data = imap.search(None, "ALL")
            if status != "OK" or not data or not data[0]:
                return None

            ids = data[0].split()
            if not ids:
                return None

            latest_id = ids[-1]
            status, msg_data = imap.fetch(latest_id, "(RFC822)")
            if status != "OK" or not msg_data:
                return None

            raw = None
            for part in msg_data:
                if isinstance(part, tuple) and len(part) >= 2:
                    raw = part[1]
                    break
            if raw is None:
                return None

            msg = email_lib.message_from_bytes(raw)
            body = self._extract_body(msg)
            return {
                "id": (msg.get("Message-ID") or latest_id.decode(errors="ignore")),
                "uid": latest_id.decode(errors="ignore"),
                "subject": self._decode(msg.get("Subject")),
                "from": self._decode(msg.get("From")),
                "body_text": body,
                "body_html": body,
            }
        except imaplib.IMAP4.error as e:
            print(f"[Outlook] IMAP ошибка: {e}")
            return None
        except Exception as e:
            print(f"[Outlook] ошибка получения письма: {e}")
            return None
        finally:
            if imap is not None:
                try:
                    imap.logout()
                except Exception:
                    pass

    @staticmethod
    def extract_6_digit_code(message: dict) -> Optional[str]:
        """Извлечь 6-значный код подтверждения из тела письма."""
        if not message:
            return None

        candidates = []
        for field in ("body_text", "body_html", "subject", "text", "html", "body"):
            val = message.get(field)
            if isinstance(val, str):
                candidates.append(val)

        for text in candidates:
            m = re.search(r"(?:code\s*(?:is)?\s*[:\-]?\s*)(\d{6})", text, re.IGNORECASE)
            if m:
                return m.group(1)

        for text in candidates:
            m = re.search(r"\b(\d{6})\b", text)
            if m:
                return m.group(1)

        return None

    def wait_for_code(
        self,
        email: str,
        password: str,
        folder: str = "INBOX",
        timeout_sec: int = 30,
        poll_interval_sec: float = 3.0,
        ignore_message_id: Optional[str] = None,
    ) -> Optional[str]:
        """
        Опрашивает Outlook через graph2imap каждые poll_interval_sec секунд
        в течение timeout_sec. Возвращает 6-значный код или None.
        """
        deadline = time.time() + timeout_sec
        print(f"[Outlook] ожидание кода на {email} "
              f"(timeout {timeout_sec}s, опрос каждые {poll_interval_sec}s)")

        while time.time() < deadline:
            msg = self.get_latest_message(email, password=password, folder=folder)
            if msg:
                msg_id = msg.get("id") or msg.get("message_id") or msg.get("uid")
                if ignore_message_id and msg_id == ignore_message_id:
                    pass
                else:
                    code = self.extract_6_digit_code(msg)
                    if code:
                        print(f"[Outlook] получен код: {code}")
                        return code

            time.sleep(poll_interval_sec)

        print(f"[Outlook] таймаут {timeout_sec}s истёк, код не получен")
        return None


def parse_mail_line(line: str):
    """
    Разбирает строку формата mail:pass:client_id:refresh_token.

    Возвращает кортеж (email, password, client_id, refresh_token).
    Терпима к лишним двоеточиям в refresh_token (склеивает хвост обратно).
    """
    line = (line or "").strip()
    if not line:
        return None
    parts = line.split(":")
    if len(parts) < 2:
        return None
    email = parts[0].strip()
    password = parts[1].strip() if len(parts) > 1 else ""
    client_id = parts[2].strip() if len(parts) > 2 else ""
    # refresh_token может содержать двоеточия - собираем хвост обратно
    refresh_token = ":".join(parts[3:]).strip() if len(parts) > 3 else ""
    return email, password, client_id, refresh_token
