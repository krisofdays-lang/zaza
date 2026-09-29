import json
import random
import time
import uuid
from typing import Optional, Dict, Any

import requests


# ============================================================================
# DEVICE / USER-AGENT
# ============================================================================

# (hardware_string, "WIDTHxHEIGHT", "scale")  — внутренне согласованные профили
# реальных iPhone. Разрешение/scale должны соответствовать модели, иначе UA
# выглядит "склеенным" и легко детектится.
IPHONE_DEVICES = [
    ("iPhone17,1", "1206x2622", "3.00"),  # iPhone 16 Pro
    ("iPhone17,2", "1320x2868", "3.00"),  # iPhone 16 Pro Max
    ("iPhone17,3", "1179x2556", "3.00"),  # iPhone 16
    ("iPhone17,4", "1290x2796", "3.00"),  # iPhone 16 Plus
]

# Свежие сборки iOS (формат UA использует подчёркивания: 18_5).
IOS_VERSIONS = [
    "17_5_1", "17_6_1", "17_7",
    "18_0_1", "18_1_1", "18_2_1", "18_3_1", "18_4_1", "18_5", "18_6_1",
]

# ============================================================================
# BUILD-ПРОФИЛИ: (версия приложения + bloks_versioning_id + app_id)
# ============================================================================
# bloks_versioning_id — это ХЕШ КОНКРЕТНОЙ СБОРКИ Instagram. Его НЕЛЬЗЯ
# сгенерировать: он берётся из реального дампа (APK/IPA или mitmproxy-перехвата)
# конкретной версии приложения. Поэтому версия в User-Agent, bloks_versioning_id
# и app_id ОБЯЗАНЫ принадлежать одной и той же сборке — иначе фингерпринт
# выглядит "склеенным".
#
# Каждый элемент BUILD_PROFILES = одна согласованная тройка из одного дампа.
# Чтобы РОТИРОВАТЬ версии без рассогласования, добавляй сюда новые тройки,
# взятые из реальных дампов соответствующих версий приложения.
#
# ВАЖНО: ig_version у единственной тройки ниже должен соответствовать ВЕРСИИ,
# из которой реально снят этот bloks_versioning_id. Если знаешь её точно —
# поправь ig_version. Пока оставляем один профиль -> версия НЕ рандомится и
# всегда согласована с bloks_id.
BUILD_PROFILES = [
    {
        "ig_version": "448.0.0.39.66",
        "bloks_versioning_id":
            "962e8adcff14724d83afff88f2db8ff321b1d3cf53fee9b37a9fcaa1eb9a0306",
        "ig_app_id": "124024574287414",
    },
]

# РЕЖИМ СВЕРКИ (рассинхрон): версия в UA рандомится по этому списку, а
# bloks_versioning_id остаётся ОДИН (из BUILD_PROFILES[0]). Это намеренно
# рассогласовано — как было до синхронизации, чтобы можно было сравнить.
IG_APP_VERSIONS = [
    "448.0.0.39.66",
]

# Локали оставляем англоязычными — соответствует остальным заголовкам/JSON.
LOCALES = [("en_US", "en"), ("en_GB", "en")]


def pick_build_profile() -> Dict[str, str]:
    """Возвращает случайную согласованную тройку (версия + bloks_id + app_id)."""
    return random.choice(BUILD_PROFILES)


def gen_user_agent(ig_version: Optional[str] = None) -> str:
    """
    Возвращает согласованный iOS Instagram User-Agent вида:

      Instagram 390.0.0.30.107 (iPhone17,1; iOS 18_5; en_US; en;
        scale=3.00; 1206x2622; 849447290) AppleWebKit/420+

    РЕЖИМ СВЕРКИ: версия приложения рандомится по IG_APP_VERSIONS (рассинхрон с
    фиксированным bloks_versioning_id). Модель/iOS/build тоже рандомизируются.
    """
    model, resolution, scale = random.choice(IPHONE_DEVICES)
    ios = random.choice(IOS_VERSIONS)
    ig_ver = random.choice(IG_APP_VERSIONS)
    locale, lang = random.choice(LOCALES)
    build = 1072661960
    return (
        f"Instagram {ig_ver} ({model}; iOS {ios}; {locale}; {lang}; "
        f"scale={scale}; {resolution}; {build}) AppleWebKit/420+"
    )


# ============================================================================
# PROXY
# ============================================================================

def normalize_proxy(proxy: Optional[str]) -> Optional[str]:
    """
    Приводит строку прокси к виду, понятному requests.
    Поддерживает:
      - http://user:pass@host:port
      - https://host:port
      - socks5://user:pass@host:port   (требует PySocks)
      - socks5h://host:port            (резолв DNS на стороне прокси)
      - host:port                      -> трактуется как http://host:port
      - host:port:user:pass            -> http://user:pass@host:port
    Возвращает None, если proxy пустой.
    """
    if not proxy:
        return None
    proxy = proxy.strip()
    if "://" in proxy:
        return proxy
    parts = proxy.split(":")
    if len(parts) == 2:
        host, port = parts
        return f"http://{host}:{port}"
    if len(parts) == 4:
        host, port, user, pwd = parts
        return f"http://{user}:{pwd}@{host}:{port}"
    # неизвестный формат — отдаём как есть с http-схемой
    return f"http://{proxy}"


def configure_session_proxy(session: requests.Session, proxy: Optional[str]) -> None:
    """
    Навешивает прокси на requests.Session для http и https.
    Для socks5:// / socks5h:// нужен установленный PySocks
    (pip install "requests[socks]").
    """
    norm = normalize_proxy(proxy)
    if not norm:
        return
    session.proxies = {"http": norm, "https": norm}


def resolve_proxy_ip(proxy: Optional[str], timeout: float = 8.0) -> Optional[str]:
    """
    Возвращает РЕАЛЬНЫЙ внешний IP, который виде�� через данный прокси.

    Нужен, чтобы убедиться, что два разных прокси (разные строки login:pass@host)
    не выходят в интернет с ОДНОГО И ТОГО ЖЕ IP - иначе Instagram видит несколько
    регистраций с одного адреса, несмотря на "разные" прокси.

    None - если прокси не задан или IP не удалось определить.
    """
    if not proxy:
        return None
    norm = normalize_proxy(proxy)
    if not norm:
        return None
    try:
        r = requests.get(
            "http://ip-api.com/json/?fields=status,query",
            proxies={"http": norm, "https": norm},
            timeout=timeout,
        )
        data = r.json()
        if data.get("status") == "success":
            return data.get("query")
    except Exception:
        pass
    return None


def resolve_proxy_quality(proxy: Optional[str], timeout: float = 8.0) -> Dict[str, Any]:
    """
    Возвращает информацию о прокси: реальный IP + признаки датацентра.

    Instagram при РЕГИСТРАЦИИ почти всегда режет датацентровые/хостинговые IP
    (ошибка "We limit how often you can do certain things"). ip-api отдаёт два
    флага:
      * hosting=True  -> IP принадлежит дата-центру/хостингу (плохо для реги)
      * proxy=True    -> IP помечен как прокси/VPN (тоже плохо)
    Резидентские и мобильные прокси обычно имеют hosting=False, proxy=False.

    Возвращает dict: {"ip": str|None, "hosting": bool, "proxy": bool,
                      "ok": bool}  где ok=False если определить не удалось.
    """
    out = {"ip": None, "hosting": False, "proxy": False, "ok": False}
    if not proxy:
        return out
    norm = normalize_proxy(proxy)
    if not norm:
        return out
    try:
        r = requests.get(
            "http://ip-api.com/json/?fields=status,query,proxy,hosting",
            proxies={"http": norm, "https": norm},
            timeout=timeout,
        )
        data = r.json()
        if data.get("status") == "success":
            out["ip"] = data.get("query")
            out["hosting"] = bool(data.get("hosting"))
            out["proxy"] = bool(data.get("proxy"))
            out["ok"] = True
    except Exception:
        pass
    return out


# ============================================================================
# common_headers — версия с параметром user_agent (замени свою на эту)
# ============================================================================

# Значения по умолчанию берём из ПЕРВОГО build-профиля, чтобы был один источник
# истины: bloks_versioning_id и app_id всегда из той же сборки, что и версия в UA.
BLOKS_VERSION_ID = BUILD_PROFILES[0]["bloks_versioning_id"]
IG_APP_ID = BUILD_PROFILES[0]["ig_app_id"]
FB_HTTP_ENGINE = "Tigon/MNS/TCP"
BK_CONTEXT = {
    "pixel_ratio": 3,
    "styles_id": "instagram",
    "theme_params": [
        {"design_system_name": "XMDS", "value": ["three_neutral_gray"]}
    ],
}
class DeviceProfile:
    """Взаимосогласованный профиль одного устройства."""

    def __init__(self, model_code, resolution, ios_version, ig_version):
        self.model_code = model_code        # "iPhone17,1"
        self.resolution = resolution        # "1206x2622"
        self.ios_version = ios_version      # "18_5"
        self.ig_version = ig_version        # "410.1.0.36.70"
        self.dpi_build = str(random.randint(100_000_000, 999_999_999))
        # device locale ставится позже из geo (по умолчанию en_US)
        self.locale = "en_US"
        self.language = "en"

    @classmethod
    def random(cls):
        model_code, resolution = random.choice(IPHONE_DEVICES)
        return cls(
            model_code=model_code,
            resolution=resolution,
            ios_version=random.choice(IOS_VERSIONS),
            ig_version=random.choice(IG_APP_VERSIONS),
        )

    @property
    def user_agent(self) -> str:
        # Instagram <ver> (<model>; iOS <ios>; <locale>; <lang>; scale=3.00; <res>; <build>) AppleWebKit/420+
        return (
            f"Instagram {self.ig_version} "
            f"({self.model_code}; iOS {self.ios_version}; {self.locale}; {self.language}; "
            f"scale=3.00; {self.resolution}; {self.dpi_build}) AppleWebKit/420+"
        )
# --------------------------------------------------------------------------
# 2. ГЕО ПО IP ПРОКСИ
# --------------------------------------------------------------------------
# Карта страна(ISO-2) -> (locale, language, accept-language). Покрывает частые
# гео прокси; для остальных — фолбэк en_US, но timezone всё равно берётся из IP.
_COUNTRY_LOCALE = {
    "US": ("en_US", "en", "en-US"),
    "GB": ("en_GB", "en", "en-GB"),
    "CA": ("en_CA", "en", "en-CA"),
    "AU": ("en_AU", "en", "en-AU"),
    "DE": ("de_DE", "de", "de-DE"),
    "FR": ("fr_FR", "fr", "fr-FR"),
    "ES": ("es_ES", "es", "es-ES"),
    "IT": ("it_IT", "it", "it-IT"),
    "BR": ("pt_BR", "pt", "pt-BR"),
    "PT": ("pt_PT", "pt", "pt-PT"),
    "RU": ("ru_RU", "ru", "ru-RU"),
    "TR": ("tr_TR", "tr", "tr-TR"),
    "TH": ("th_TH", "th", "th-TH"),
    "ID": ("id_ID", "id", "id-ID"),
    "VN": ("vi_VN", "vi", "vi-VN"),
    "IN": ("en_IN", "en", "en-IN"),
    "JP": ("ja_JP", "ja", "ja-JP"),
    "KR": ("ko_KR", "ko", "ko-KR"),
    "MX": ("es_MX", "es", "es-MX"),
    "PH": ("en_PH", "en", "en-PH"),
    "NL": ("nl_NL", "nl", "nl-NL"),
    "PL": ("pl_PL", "pl", "pl-PL"),
}


def _geo_from_country(country: str, tz_offset_seconds: int) -> Dict[str, Any]:
    country = (country or "US").upper()
    locale, language, accept = _COUNTRY_LOCALE.get(country, ("en_US", "en", "en-US"))
    return {
        "country": country,
        "tz_offset_seconds": int(tz_offset_seconds),
        "locale": locale,
        "language": language,
        "accept_language": f"{accept};q=1.0",
    }


def resolve_geo(session, fallback_country: Optional[str] = None, timeout: float = 8.0) -> Dict[str, Any]:
    """
    Определяет страну/таймзону по IP прокси (через переданную session, т.е. уже
    с навешенным proxy). Источник: ip-api.com (без ключа), отдаёт countryCode и
    offset (секунды UTC). При ошибке — фолбэк на fallback_country (или US, tz из
    локального времени как грубый запас).
    """
    try:
        r = session.get(
            "http://ip-api.com/json/?fields=status,countryCode,offset,timezone,query",
            timeout=timeout,
        )
        data = r.json()
        if data.get("status") == "success":
            return _geo_from_country(data["countryCode"], data.get("offset", 0))
    except Exception:
        pass

    # фолбэк
    if fallback_country:
        # грубое сопоставление часового пояса по стране делать не будем —
        # ставим 0, лучше передать geo_country, для которого знаем оффсет ниже.
        offset = _FALLBACK_TZ.get(fallback_country.upper(), 0)
        return _geo_from_country(fallback_country, offset)
    # совсем крайний случай: локальная таймзона раннера (не идеально, но не US-хардкод)
    offset = -int(time.timezone)  # секунды; time.timezone = -offset
    return _geo_from_country("US", offset)


# Запасные оффсеты (секунды UTC) для частых стран — на случай, когда IP не пробить,
# но страна прокси известна и передана как geo_country.
_FALLBACK_TZ = {
    "US": -18000, "GB": 0, "DE": 3600, "FR": 3600, "ES": 3600, "IT": 3600,
    "RU": 10800, "TR": 10800, "TH": 25200, "ID": 25200, "VN": 25200,
    "IN": 19800, "JP": 32400, "KR": 32400, "BR": -10800, "MX": -21600,
    "PH": 28800, "AU": 36000, "CA": -18000, "NL": 3600, "PL": 3600, "PT": 0,
}
def gen_family_device_id() -> str:
    """family_device_id — валидный UUID (uppercase), как у реального iOS-клиента.
    Раньше в params слался None — это детерминированный анти-абьюз флаг."""
    return str(uuid.uuid4()).upper()

# --------------------------------------------------------------------------
# 3. ТОКЕНЫ
# --------------------------------------------------------------------------
def gen_cloud_trust_token() -> str:
    """Два UPPERCASE UUID встык, без разделителя (как в реальном дампе: <UUID><UUID>).
    Исправляет старый баг с no-op .replace('-', '-', 4)."""
    return str(uuid.uuid4()).upper() + str(uuid.uuid4()).upper()


# --------------------------------------------------------------------------
# 4. СТОХАСТИКА CONNECTION-ХЕДЕРОВ
# --------------------------------------------------------------------------
class ConnectionProfile:
    """Правдоподобные, ВЗАИМНО-СОГЛАСОВАННЫЕ connection-заголовки на один прогон."""

    def __init__(self, conn_type, speed_kbps, bandwidth_kbps, bandwidth_ttfb_ms):
        self.conn_type = conn_type          # "WiFi" | "MobileLTE" | "Mobile5G"
        self.speed_kbps = speed_kbps
        self.bandwidth_kbps = bandwidth_kbps
        self.bandwidth_ttfb_ms = bandwidth_ttfb_ms

    @classmethod
    def random(cls):
        kind = random.choices(["WiFi", "MobileLTE", "Mobile5G"], weights=[55, 30, 15])[0]
        if kind == "WiFi":
            speed = random.randint(2000, 60000)
        elif kind == "MobileLTE":
            speed = random.randint(800, 18000)
        else:  # 5G
            speed = random.randint(15000, 120000)
        # bandwidth немного коррелирует со speed
        bandwidth = float(speed) * random.uniform(0.85, 1.15)
        ttfb = random.randint(80, 600)
        return cls(kind, speed, round(bandwidth, 3), ttfb)

    @property
    def fb_connection_type(self) -> str:
        return "wifi" if self.conn_type == "WiFi" else "cell"

    @property
    def ig_connection_type(self) -> str:
        # x-ig-connection-type: WIFI / WWAN
        return "WiFi" if self.conn_type == "WiFi" else "WWAN"


# --------------------------------------------------------------------------
# 5. СБОРКА ЗАГОЛОВКОВ С УЧЁТОМ ПРОФИЛЯ/ГЕО/CONNECTION
# --------------------------------------------------------------------------
def common_headers(device_id: str,
                   mid: str = "",
                   user_agent: str = None,
                   geo: Optional[Dict[str, Any]] = None,
                   bloks_versioning_id: str = None,
                   app_id: str = None) -> Dict[str, str]:
    """
    Заголовки с гео, согласованным со страной прокси.
    Если geo не передан — дефолт US (как раньше), но это НЕ рекомендуется
    при использовании прокси другой страны.

    bloks_versioning_id / app_id можно передать из build-профиля аккаунта, чтобы
    они совпадали с версией приложения в User-Agent. По умолчанию — глобальные
    (= первый профиль).
    """
    if geo is None:
        geo = _geo_from_country("US", -18000)

    ua = user_agent or gen_user_agent()
    bloks_id = bloks_versioning_id or BLOKS_VERSION_ID
    app = app_id or IG_APP_ID

    headers = {
        "accept-language": geo["accept_language"],          # было en-US;q=1.0
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "ig-intended-user-id": "0",
        "priority": "u=2, i",
        "user-agent": ua,
        "x-bloks-version-id": bloks_id,
        "x-fb-client-ip": "True",
        "x-fb-connection-type": "wifi",
        "x-fb-server-cluster": "True",
        "x-ig-app-id": app,
        "x-ig-app-locale": geo["language"],                 # было "en"
        "x-ig-bandwidth-speed-kbps": "0.000",
        "x-ig-bloks-serialize-payload": "true",
        "x-ig-capabilities": "36r/F/8=",
        "x-ig-connection-speed": f"{random.randint(1000, 5000)}kbps",
        "x-ig-connection-type": "WiFi",
        "x-ig-device-id": device_id,
        "x-ig-device-locale": geo["locale"],         # было "en-US"
        "x-ig-mapped-locale": geo["locale"],                # было "en_US"
        "x-ig-timezone-offset": str(geo["tz_offset_seconds"]),  # было "-18000"
        "x-tigon-is-retry": "False",
        "x-ig-transfer-encoding": "chunked",
        "x-fb-http-engine": FB_HTTP_ENGINE,
        "x-fb-rmd": "state=URL_ELIGIBLE",
        "bloks_versioning_id": bloks_id,
        "bk_client_context": json.dumps(BK_CONTEXT, separators=(",", ":")),
    }
    if mid:
        headers["x-mid"] = mid
    return headers
