"""
anymessage_client.py - Получение писем/кода Instagram через AnyMessage Email Activation API.

Альтернатива Outlook (graph2imap). Документация: https://anymessage.shop/docs

Поток работы (короткоживущие почты):
    1. order_email(site, domain) -> получаем email-адрес и activation id
    2. wait_for_code()           -> опрашиваем getmessage по id, пока не придёт код

Интерфейс класса намеренно совпадает с OutlookClient, чтобы emailz.py и
InstagramRegistration работали без изменений:
    get_latest_message(email, password, folder)
    extract_6_digit_code(message)   (staticmethod)
    wait_for_code(email, password, folder, timeout_sec, poll_interval_sec, ignore_message_id)
"""

import re
import random
import time
from typing import Optional

import requests
from requests.adapters import HTTPAdapter

try:
    # urllib3 >= 1.26 (устанавливается вместе с requests)
    from urllib3.util.retry import Retry
except Exception:  # pragma: no cover
    Retry = None


API_BASE = "https://api.anymessage.shop"

# Раздельные таймауты (connect, read): короткий connect — быстро понять, что
# соединение не устанавливается, и уйти в ретрай; более длинный read — дать
# серверу время отдать ответ. Плоский timeout=30 на connect был причиной
# ConnectTimeout при сетевых всплесках.
DEFAULT_CONNECT_TIMEOUT = 10.0
DEFAULT_READ_TIMEOUT = 30.0

# Сайт, под который заказываем почту, и домены (можно перечислить через запятую).
DEFAULT_SITE = "instagram.com"
DEFAULT_DOMAIN = "hotmail,outlook,mailcom,gmx"


class AnyMessageClient:
    """
    Клиент AnyMessage Email Activation API.

    Создаётся на один аккаунт. После order_email() хранит активный
    activation id и адрес заказанной почты.
    """

    def __init__(
        self,
        token: str,
        site: str = DEFAULT_SITE,
        domain: str = DEFAULT_DOMAIN,
        timeout: float = 30.0,
        connect_timeout: float = DEFAULT_CONNECT_TIMEOUT,
        proxy: Optional[str] = None,
    ):
        self.token = token or ""
        self.site = site
        self.domain = domain
        # timeout как (connect, read). Сохраняем совместимость: если передан
        # один timeout — используем его как read-таймаут.
        self.timeout = (connect_timeout, float(timeout))

        # Персистентная сессия с ретраями и keep-alive. Пул соединений и
        # автоматические повторы на connect/read-таймаут и 5xx делают опрос
        # устойчивым к сетевым всплескам до api.anymessage.shop.
        self.session = requests.Session()

        # ОПЦИОНАЛЬНЫЙ прокси для запросов к API AnyMessage. По умолчанию None —
        # ходим напрямую (это быстрее и стабильнее, т.к. резидентные/мобильные
        # прокси часто дают ConnectTimeout). Прокси имеет смысл включать, только
        # если рейтлимит навешен на IP; если лимит на token — прокси не поможет.
        if proxy:
            self.session.proxies.update({"http": proxy, "https": proxy})
        if Retry is not None:
            retry = Retry(
                total=4,
                connect=4,      # повторять именно connect-таймауты
                read=2,
                backoff_factor=1.0,  # 0s, 1s, 2s, 4s между попытками
                status_forcelist=(429, 500, 502, 503, 504),
                allowed_methods=frozenset(["GET"]),
            )
            adapter = HTTPAdapter(max_retries=retry, pool_connections=8,
                                  pool_maxsize=8)
            self.session.mount("https://", adapter)
            self.session.mount("http://", adapter)

        # Заполняются после order_email()
        self.activation_id: Optional[str] = None
        self.email: Optional[str] = None
        # Был ли реально получен код по текущей активации. Нужен для возврата
        # баланса: AnyMessage возвращает деньги ТОЛЬКО если письмо не пришло,
        # поэтому отменять активацию имеет смысл лишь при code_received == False.
        self.code_received: bool = False

    # ----- заказ почты -----------------------------------------------------

    def order_email(self, site: Optional[str] = None, domain: Optional[str] = None):
        """
        Заказывает короткоживущую почту. Возвращает (email, activation_id).
        Бросает RuntimeError при ошибке API.
        """
        params = {
            "token": self.token,
            "site": site or self.site,
            "domain": domain or self.domain,
        }
        r = self._get("/email/order", params)
        data = self._json(r)
        if data.get("status") != "success":
            raise RuntimeError(f"[AnyMessage] order_email ошибка: {data.get('value', data)}")

        self.activation_id = str(data.get("id"))
        self.email = data.get("email")
        self.code_received = False  # новая активация — код ещё не получен
        print(f"[AnyMessage] заказана почта {self.email} (id={self.activation_id})")
        return self.email, self.activation_id

    def reorder_email(self):
        """Перезаказывает письмо для текущего activation id (если первое не дошло)."""
        if not self.activation_id:
            return None
        params = {"token": self.token, "id": self.activation_id}
        r = self._get("/email/reorder", params)
        data = self._json(r)
        if data.get("status") == "success":
            self.activation_id = str(data.get("id", self.activation_id))
            self.email = data.get("email", self.email)
        return data

    def cancel_email(self):
        """Отменяет активацию (например, если регистрация не удалась)."""
        if not self.activation_id:
            return None
        params = {"token": self.token, "id": self.activation_id}
        try:
            r = self._get("/email/cancel", params)
            return self._json(r)
        except Exception as e:
            print(f"[AnyMessage] cancel ошибка: {e}")
            return None

    # ----- внутреннее ------------------------------------------------------

    def _get(self, path: str, params: dict) -> requests.Response:
        """GET через персистентную сессию с ретраями и (connect, read) таймаутом."""
        return self.session.get(f"{API_BASE}{path}", params=params,
                                timeout=self.timeout)

    @staticmethod
    def _json(r: requests.Response) -> dict:
        try:
            return r.json()
        except Exception:
            return {"status": "error", "value": "bad json", "raw": r.text}

    def _get_message_raw(self) -> Optional[str]:
        """
        Запрашивает getmessage по текущему activation id.
        Возвращает HTML письма или None, если письмо ещё ��е пришл��.

        ВАЖНО: сетевые исключения (Timeout/ConnectionError) и ВРЕМЕННЫЕ ошибки
        API ("wait message", а также серверные сбои вида "failed to retrieve"/
        "timeout ... exceeded") НЕ должны прерывать регистрацию — они означают
        "письмо ещё не готово, опроси позже". Раньше requests.get() без try/except
        поднимал исключение наверх и убивал регистрацию, хотя код по факту
        приходил и следующий ��прос бы его получил.
        """
        if not self.activation_id:
            return None
        params = {"token": self.token, "id": self.activation_id}
        try:
            r = self._get("/email/getmessage", params)
        except requests.RequestException as e:
            # Сетевой таймаут/обрыв — считаем, что письмо просто ещё не пришло.
            print(f"[AnyMessage] getmessage сетевая ошибка (повтор): "
                  f"{type(e).__name__}: {e}")
            return None
        data = self._json(r)
        if data.get("status") == "success":
            return data.get("message") or ""
        # Разбираем value: часть значений — временные (ждём дальше), часть — фатальные.
        value = (data.get("value") or "").strip()
        low = value.lower()
        transient = (
            not value
            or low == "wait message"
            or "wait" in low
            or "timeout" in low
            or "time out" in low
            or "failed to retrieve" in low
            or "retrieve" in low
            or "try again" in low
            or "temporarily" in low
        )
        if value and not transient:
            # Реальная ошибка (например activation canceled / no activation).
            print(f"[AnyMessage] getmessage ошибка: {value}")
        elif value and low != "wait message":
            # Временная — логируем, но продолжаем опрос.
            print(f"[AnyMessage] getmessage временно недоступно (повтор): {value}")
        return None

    # ----- публичный интерфейс (совместим с OutlookClient) -----------------

    def get_latest_message(
        self,
        email: str = "",
        password: str = "",
        folder: str = "INBOX",
    ) -> Optional[dict]:
        """
        Возвращает последнее письмо в виде dict (body_text/body_html), либо None.
        email/password/folder игнорируются: используется activation_id.
        """
        html = self._get_message_raw()
        if not html:
            return None
        return {
            "id": self.activation_id,
            "uid": self.activation_id,
            "subject": "",
            "from": "",
            "body_text": html,
            "body_html": html,
        }

    @staticmethod
    def extract_6_digit_code(message: dict) -> Optional[str]:
        """Извлечь 6-значный код подтверждения из тела письма."""
        if not message:
            return None

        candidates = []
        for field in ("body_text", "body_html", "subject", "text", "html", "body", "message"):
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
        email: str = "",
        password: str = "",
        folder: str = "INBOX",
        timeout_sec: int = 60,
        poll_interval_sec: float = 3.0,
        ignore_message_id: Optional[str] = None,
    ) -> Optional[str]:
        """
        Опрашивает AnyMessage getmessage каждые poll_interval_sec секунд
        в течение timeout_sec. Возвращает 6-значный код или None.
        """
        deadline = time.time() + timeout_sec
        print(f"[AnyMessage] ожидание кода на {self.email} "
              f"(id={self.activation_id}, timeout {timeout_sec}s)")

        # СТАРТОВЫЙ СДВИГ (анти-thundering-herd): при THREADS>1 все потоки
        # стартуют почти одновременно и без этого бьют по API синхронными
        # пачками. Случайная задержка 0..poll_interval разводит фазы опроса,
        # чтобы запросы к api.anymessage.shop размазались во времени.
        initial_jitter = random.uniform(0.0, poll_interval_sec)
        if initial_jitter > 0 and time.time() + initial_jitter < deadline:
            time.sleep(initial_jitter)

        while time.time() < deadline:
            msg = self.get_latest_message()
            if msg:
                code = self.extract_6_digit_code(msg)
                if code:
                    self.code_received = True
                    print(f"[AnyMessage] получен код: {code}")
                    return code
            # Интервал с джиттером ±30%, чтобы потоки не пересинхронизировались
            # обратно после первого совпадения фаз.
            jittered = poll_interval_sec * random.uniform(0.7, 1.3)
            time.sleep(jittered)

        print(f"[AnyMessage] таймаут {timeout_sec}s истёк, код не получен")
        return None

    # ----- утилиты ---------------------------------------------------------

    def get_balance(self) -> Optional[str]:
        """Возвращает баланс аккаунта AnyMessage (строкой) или None."""
        try:
            r = requests.get(f"{API_BASE}/user/balance",
                             params={"token": self.token}, timeout=self.timeout)
            data = self._json(r)
            if data.get("status") == "success":
                return data.get("balance")
        except Exception as e:
            print(f"[AnyMessage] balance ошибка: {e}")
        return None
