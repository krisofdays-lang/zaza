"""
manual_client.py - Ручной ввод кода подтверждения (iCloud и любой другой ящик,
к которому нет API-доступа).

Идея: аккаунт регистрируется на заранее заданный email (например, @icloud.com),
код приходит тебе на реальное устройство/в почту, и ты вводишь его ВРУЧНУЮ
в терминал. Никакого ожидания письма из API — скрипт просто спрашивает код.

Класс реализует тот же интерфейс, что OutlookClient / AnyMessageClient /
TextverifiedClient, поэтому emailz.obtain_confirmation_code(reg) работает с ним
без изменений (используется путь mail_client, contactpoint_type = email):

    get_latest_message(...)          -> заглушка (None)
    extract_6_digit_code(message)    -> staticmethod
    wait_for_code(email, password, folder, timeout_sec, poll_interval_sec,
                  ignore_message_id) -> запрашивает код через input()

Потокобезопасность: ввод сериализуется глобальным замком, чтобы при THREADS > 1
приглашения из разных потоков не перемешивались. Тем не менее для ручного ввода
рекомендуется THREADS = 1.
"""

import re
import threading
import time
from typing import Optional


# Один общий замок на все экземпляры: одновременно вводим код только для
# одного аккаунта, иначе приглашения input() из разных потоков смешаются.
_INPUT_LOCK = threading.Lock()


class ManualCodeClient:
    """
    Клиент "ручного ввода" кода подтверждения (для iCloud и т.п.).

    Args:
        email: адрес ящика, на который зарегистрируется аккаунт (для подсказки
               в терминале). Необязателен — можно передавать при wait_for_code.
        email_password: пароль ящика (не используется для получения кода,
               хранится только для последующей записи в accounts.xlsx).
        prompt_timeout: сколько секунд ждать ручного ввода, прежде чем сдаться
               (0 или None = ждать бесконечно).
    """

    def __init__(
        self,
        email: str = "",
        email_password: str = "",
        prompt_timeout: Optional[float] = None,
    ):
        self.email = email
        self.email_password = email_password
        self.prompt_timeout = prompt_timeout

    # ----- Совместимость с остальными клиентами ------------------------------

    def get_latest_message(
        self,
        phone: str = "",
        password: str = "",
        folder: str = "INBOX",
    ) -> Optional[dict]:
        """Заглушка: у ручного клиента нет доступа к ящику."""
        return None

    @staticmethod
    def extract_6_digit_code(message: dict) -> Optional[str]:
        """Достаёт 6 цифр из произвольной строки (на случай если код введён
        с пробелами/дефисами, напр. '692 014')."""
        if not message:
            return None
        for field in ("parsed_code", "body_text", "body_html", "subject"):
            val = message.get(field)
            if isinstance(val, str):
                digits = re.sub(r"\D", "", val)
                if len(digits) == 6:
                    return digits
        return None

    # ----- Основной метод: ручной ввод --------------------------------------

    def wait_for_code(
        self,
        email: str = "",
        password: str = "",
        folder: str = "INBOX",
        timeout_sec: int = 120,
        poll_interval_sec: float = 3.0,
        ignore_message_id: Optional[str] = None,
    ) -> Optional[str]:
        """
        Запрашивает 6-значный код у оператора через терминал.

        Возвращает нормализованный код (только цифры, ровно 6) или None,
        если ввод не дал корректного кода за отведённое время.
        """
        target = email or self.email or "(email не указан)"
        # prompt_timeout из конструктора имеет приоритет; иначе берём timeout_sec.
        deadline = None
        limit = self.prompt_timeout if self.prompt_timeout is not None else timeout_sec
        if limit and limit > 0:
            deadline = time.time() + float(limit)

        with _INPUT_LOCK:
            print("\n" + "=" * 60)
            print(f"[РУЧНОЙ ВВОД] Введите код подтверждения Instagram для:")
            print(f"              {target}")
            print("              (6 цифр; можно с пробелами, напр. '692 014')")
            if deadline:
                print(f"              таймаут: {int(limit)} c")
            print("=" * 60)

            while True:
                if deadline and time.time() >= deadline:
                    print("[РУЧНОЙ ВВОД] таймаут истёк, код не введён")
                    return None

                try:
                    raw = input("Код > ").strip()
                except (EOFError, KeyboardInterrupt):
                    print("\n[РУЧНОЙ ВВОД] ввод прерван")
                    return None

                if not raw:
                    print("  пустой ввод — попробуйте ещё раз")
                    continue

                digits = re.sub(r"\D", "", raw)
                if len(digits) == 6:
                    print(f"[РУЧНОЙ ВВОД] принят код: {digits}")
                    return digits

                print(f"  нужно ровно 6 цифр (введено {len(digits)}) — ещё раз")


def load_icloud_lines(path: str):
    """
    Читает ящики iCloud из файла. Поддерживает форматы строк:
        email
        email:password
    Комментарии (#) и пустые строки игнорируются.
    Возвращает список кортежей (email, password).
    """
    import os
    out = []
    if not os.path.exists(path):
        return out
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if ":" in line:
                email, password = line.split(":", 1)
            else:
                email, password = line, ""
            out.append((email.strip(), password.strip()))
    return out
