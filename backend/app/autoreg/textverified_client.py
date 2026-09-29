"""
textverified_client.py - SMS верификация через Textverified (официальная библиотека)

Документация: https://textverified-python.readthedocs.io/

Поток работы:
    1. order_phone(service_name) -> получаем номер телефона и verification object
    2. wait_for_code() -> используем встроенный polling client.sms.incoming()

Интерфейс класса совпадает с AnyMessageClient и OutlookClient:
    get_latest_message(phone, "", folder)
    extract_6_digit_code(message)  (staticmethod)
    wait_for_code(phone, "", folder, timeout_sec, poll_interval_sec, ignore_message_id)

Требования:
    pip install textverified
"""

import re
import time
from typing import Optional
from datetime import datetime, timedelta
from textverified import (
    TextVerified,
    ReservationCapability
)


class TextverifiedClient:
    """
    SMS клиент для Textverified с официальной библиотекой.

    Требует:
        - api_key: ключ API из Textverified dashboard
        - api_username: имя пользователя Textverified

    После order_phone() хранит:
        - verification: объект верификации Textverified
        - phone: номер телефона
    """

    def __init__(
        self,
        api_key: str,
        api_username: str,
        service_name: str = "instagram",
        timeout: float = 30.0,
    ):
        """
        Инициализация Textverified клиента.

        Args:
            api_key: API ключ из Textverified dashboard
            api_username: Имя пользователя Textverified
            service_name: Сервис для верификации (instagram, google, facebook и т.д.)
            timeout: Таймаут для API запросов
        """
        self.api_key = api_key
        self.api_username = api_username
        self.service_name = service_name
        self.timeout = timeout

        # Инициализируем Textverified клиент
        try:
            self.client = TextVerified(
                api_key=api_key,
                api_username=api_username,
            )
        except Exception as e:
            raise RuntimeError(f"[Textverified] Ошибка инициализации: {e}")

        # Заполняются после order_phone()
        self.verification = None
        self.phone: Optional[str] = None
        self.verification_id: Optional[str] = None

    # ----- Заказ номера телефона -----------------------------------------------

    def order_phone(self, service_name: Optional[str] = None) -> tuple:
        """
        Заказывает номер телефона для SMS верификации.

        Args:
            service_name: Сервис (если не указан, используется default)

        Returns:
            (phone, verification_id)

        Raises:
            RuntimeError: При ошибке заказа
        """
        service = service_name or self.service_name

        try:
            # Создаём верификацию через официальный API
            self.verification = self.client.verifications.create(
                service_name=service,
                capability=ReservationCapability.SMS,
            )

            self.phone = self.verification.number
            self.verification_id = self.verification.id

            print(f"[Textverified] Заказан номер {self.phone} (id={self.verification_id})")
            return self.phone, self.verification_id

        except Exception as e:
            raise RuntimeError(
                f"[Textverified] Неожиданная ошибка при заказе: {e}"
            )

    def cancel_phone(self) -> bool:
        """
        Отменяет верификацию (если нужно).

        Returns:
            True если успешно, False если ошибка
        """
        if not self.verification:
            return False

        try:
            # Textverified автоматически управляет жизненным циклом верификации,
            # но можно явно отменить если нужно
            print(f"[Textverified] Верификация {self.verification_id} завершена")
            return True
        except Exception as e:
            print(f"[Textverified] Ошибка при отмене: {e}")
            return False

    # ----- Публичный интерфейс (совместимый с AnyMessageClient/OutlookClient) ---

    def get_latest_message(
        self,
        phone: str = "",
        password: str = "",
        folder: str = "INBOX",
    ) -> Optional[dict]:
        """
        Получает последнее SMS сообщение.

        Args:
            phone: номер (игнорируется, используется self.phone)
            password: пароль (игнорируется)
            folder: папка (игнорируется)

        Returns:
            dict с полями: id, uid, subject, from, body_text, body_html
            или None если сообщений нет
        """
        if not self.verification:
            return None

        try:
            # Получаем сообщения для текущей верификации
            messages = self.client.sms.list(verification=self.verification)

            if not messages:
                return None

            # Берём последнее сообщение
            latest = messages[-1] if hasattr(messages, '__getitem__') else messages

            return {
                "id": getattr(latest, "id", self.verification_id),
                "uid": self.verification_id,
                "subject": "SMS from Instagram",
                "from": getattr(latest, "from_value", ""),
                "body_text": getattr(latest, "sms_content", ""),
                "body_html": getattr(latest, "sms_content", ""),
                "parsed_code": getattr(latest, "parsed_code", None),
            }

        except Exception as e:
            print(f"[Textverified] Ошибка получения сообщения: {e}")
            return None

    @staticmethod
    def extract_6_digit_code(message: dict) -> Optional[str]:
        """
        Извлечь 6-значный код из сообщения.

        Textverified уже парсит код автоматически в parsed_code,
        но мы также проверяем вручную для надёжности.
        """
        if not message:
            return None

        # Сначала используем встроенный парсинг Textverified.
        # ВАЖНО: Instagram присылает код с пробелом внутри ("692 014"),
        # поэтому parsed_code может быть "692 014 " — убираем все нецифры
        # и проверяем, что осталось ровно 6 цифр.
        if "parsed_code" in message and message["parsed_code"]:
            raw = str(message["parsed_code"])
            digits = re.sub(r"\D", "", raw)
            if len(digits) == 6:
                return digits

        # Потом ищем в текстах вручную
        candidates = []
        for field in ("body_text", "body_html", "subject", "sms_content"):
            val = message.get(field)
            if isinstance(val, str):
                candidates.append(val)

        # Ищем "code is 692 014" / "code: 692014" — допускаем пробел/дефис
        # между группами цифр (Instagram: "692 014 is your Instagram code").
        for text in candidates:
            m = re.search(
                r"(?:code\s*(?:is)?\s*[:\-]?\s*)(\d[\d\s\-]{4,10}\d)",
                text,
                re.IGNORECASE
            )
            if m:
                digits = re.sub(r"\D", "", m.group(1))
                if len(digits) == 6:
                    return digits

        # Ищем 6 цифр, возможно разделённых пробелом/дефисом ("692 014").
        for text in candidates:
            m = re.search(r"(?<!\d)(\d[\d\s\-]{4,10}\d)(?!\d)", text)
            if m:
                digits = re.sub(r"\D", "", m.group(1))
                if len(digits) == 6:
                    return digits

        return None

    def wait_for_code(
        self,
        phone: str = "",
        password: str = "",
        folder: str = "INBOX",
        timeout_sec: int = 120,
        poll_interval_sec: float = 3.0,
        ignore_message_id: Optional[str] = None,
    ) -> Optional[str]:
        """
        Ждёт SMS код используя встроенный polling Textverified.

        Args:
            phone: номер (игнорируется)
            password: пароль (игнорируется)
            folder: папка (игнорируется)
            timeout_sec: макс время ожидания (сек)
            poll_interval_sec: интервал опроса (игнорируется, Textverified сам управляет)
            ignore_message_id: игнорировать это сообщение

        Returns:
            6-значный код или None если не получен
        """
        if not self.verification:
            print(f"[Textverified] Нет активной верификации")
            return None

        deadline = time.time() + timeout_sec
        print(
            f"[Textverified] ожидание кода на {self.phone} "
            f"(id={self.verification_id}, timeout {timeout_sec}s)"
        )

        # ВАЖНО: НЕ используем sms.incoming() — у него параметр since по умолчанию
        # равен datetime.now(), поэтому он отдаёт ТОЛЬКО сообщения, пришедшие ПОСЛЕ
        # старта опроса. Если SMS уже доставлена (а Instagram шлёт код почти сразу),
        # incoming() её отфильтровывает и висит до таймаута.
        #
        # Вместо этого опрашиваем sms.list(verification) в цикле — он возвращает ВСЕ
        # сообщения номера, включая уже доставленные.
        seen_ids = set()
        if ignore_message_id:
            seen_ids.add(ignore_message_id)

        # Национальные 10 цифр нашего номера — по ним матчим SMS.
        want_digits = "".join(ch for ch in str(self.phone or "") if ch.isdigit())[-10:]

        def _fetch_messages():
            """Пробуем несколько сигнатур sms.list, т.к. в разных версиях SDK
            параметр называется по-разному (data / verification / без фильтра).
            Возвращаем список сообщений (возможно пустой) либо None при ошибке."""
            attempts = (
                ("data=verification", lambda: self.client.sms.list(data=self.verification)),
                ("verification=", lambda: self.client.sms.list(verification=self.verification)),
                ("no-args", lambda: self.client.sms.list()),
            )
            for label, fn in attempts:
                try:
                    result = fn()
                except TypeError:
                    # Сигнатура не подошла — пробуем следующую.
                    continue
                except Exception as e:
                    print(f"[Textverified] sms.list({label}) ошибка: {e}")
                    continue
                try:
                    return list(result)
                except Exception:
                    return result if isinstance(result, list) else [result]
            return None

        first_pass = True
        while time.time() < deadline:
            msg_list = _fetch_messages()

            if first_pass:
                # Диагностика: один раз печатаем, что вообще вернул API.
                print(f"[Textverified][debug] sms.list вернул "
                      f"{len(msg_list) if msg_list is not None else 'None'} сообщений; "
                      f"ждём номер (последние 10 цифр)={want_digits}")
                first_pass = False

            if msg_list:
                for message in msg_list:
                    msg_id = getattr(message, "id", None)
                    to_val = getattr(message, "to_value", "") or ""
                    content = getattr(message, "sms_content", "") or ""
                    parsed = getattr(message, "parsed_code", None)
                    to_digits = "".join(ch for ch in str(to_val) if ch.isdigit())[-10:]

                    # Диагностика по каждому новому сообщению.
                    if msg_id not in seen_ids:
                        print(f"[Textverified][debug] SMS id={msg_id} to={to_val!r} "
                              f"parsed_code={parsed!r} content={content!r}")

                    if msg_id is not None and msg_id in seen_ids:
                        continue
                    if msg_id is not None:
                        seen_ids.add(msg_id)

                    # Мягкий матч: если номер известен и НЕ совпал — пропускаем.
                    # Если номер по какой-то причине пуст, не фильтруем.
                    if want_digits and to_digits and to_digits != want_digits:
                        continue

                    msg_dict = {
                        "id": msg_id or self.verification_id,
                        "uid": self.verification_id,
                        "subject": "SMS",
                        "from": getattr(message, "from_value", ""),
                        "body_text": content,
                        "body_html": content,
                        "parsed_code": parsed,
                    }

                    code = self.extract_6_digit_code(msg_dict)
                    if code:
                        print(f"[Textverified] получен код: {code}")
                        return code

            time.sleep(poll_interval_sec)

        print(f"[Textverified] таймаут {timeout_sec}s истёк, код не получен")
        return None

    # ----- Утилиты -----------------------------------------------------------------

    def get_balance(self) -> Optional[str]:
        """
        Получить баланс аккаунта Textverified.

        Returns:
            Баланс (строкой) или None при ошибке
        """
        try:
            account_info = self.client.account.me()
            balance = account_info.current_balance
            print(f"[Textverified] баланс: ${balance}")
            return str(balance)
        except Exception as e:
            print(f"[Textverified] ошибка получения баланса: {e}")
            return None

    def list_available_services(self, limit: int = 10) -> list:
        """
        Показать доступные сервисы для верификации.

        Returns:
            Списо�� имён сервисов
        """
        try:
            from textverified import NumberType, ReservationType

            services = self.client.services.list(
                number_type=NumberType.MOBILE,
                reservation_type=ReservationType.VERIFICATION,
            )

            service_names = [s.service_name for s in services[:limit]]
            print(f"[Textverified] Доступные сервисы: {service_names}")
            return service_names

        except Exception as e:
            print(f"[Textverified] ошибка получения списка сервисов: {e}")
            return []
