import json
import random
import re
import time
import uuid
from typing import Optional, Dict, Any
from urllib.parse import urlencode, quote
import gzip
import zlib
import datetime
import requests
from collections import Counter
from .outlook_client import OutlookClient
from .fingerprints import configure_session_proxy, BLOKS_VERSION_ID, \
    BK_CONTEXT, gen_user_agent, resolve_geo, _FALLBACK_TZ, gen_family_device_id, common_headers, \
    pick_build_profile
from .emailz import obtain_confirmation_code
from .textverified_client import TextverifiedClient
from .account_store import (
    build_account_record,
    save_account,
    ACCOUNTS_XLSX,
    extract_www_claim,
    extract_bearer,
)

# ============================================================================
# Константы из дампа реального клиента Instagram 410.1.0.36.70 iOS
# ============================================================================

INSTAGRAM_HOST = "https://i.instagram.com"

# x-ig-app-id (Instagram for iOS)


# x-bloks-version-id - меняется примерно раз в неделю; если запросы стали
# возвращать ошибку, первое дело обновить эту константу


# x-fb-http-engine / x-fb-rmd


# ============================================================================
# ЗАПИНЕННАЯ СБОРКА Instagram (из свежего дампа реального клиента).
#   Instagram 447.0.0.34.80 (iPhone17,1; iOS 18_5; ...)
# ВАЖНО: версия приложения, bloks_versioning_id, app_id и build-номер жёстко
# связаны между собой (это ОДНА сборка IG для iOS) — их менять НЕЛЬЗЯ, иначе
# UA рассинхронится с bloks_versioning_id. А вот МОДЕЛЬ iPhone и версия iOS —
# это железо/ОС, они НЕ зависят от сборки приложения, поэтому их можно
# рандомизировать между аккаунтами (в пределах реально поддерживаемых версий).
PINNED_IG_VERSION = "448.0.0.39.66"     # полная версия (для UA)
PINNED_IG_VERSION_SHORT = "448"         # app.ig_version в записи аккаунта
PINNED_APP_VERSION = "448.0.0"          # app.app_version в записи аккаунта
PINNED_IG_BUILD = "1072661960"          # build-номер, привязан к версии IG
PINNED_BLOKS_VERSION_ID = (
    "962e8adcff14724d83afff88f2db8ff321b1d3cf53fee9b37a9fcaa1eb9a0306"
)
PINNED_IG_APP_ID = "124024574287414"
PINNED_IG_CAPABILITIES = "36r/F/8="

# ----------------------------------------------------------------------------
# Реальные версии iOS с настоящими build-номерами. Ключи мажорных версий
# используются, чтобы подобрать устройству ОС из поддерживаемого им диапазона.
# Формат UA — версия с подчёркиваниями (16.4.1 -> 16_4_1).
IOS_RELEASES = [
    # iOS 15
    {"v": "15.5",   "build": "19F77",  "major": 15},
    {"v": "15.6",   "build": "19G71",  "major": 15},
    {"v": "15.6.1", "build": "19G82",  "major": 15},
    {"v": "15.7",   "build": "19H12",  "major": 15},
    {"v": "15.7.1", "build": "19H117", "major": 15},
    # iOS 16
    {"v": "16.1",   "build": "20B79",  "major": 16},
    {"v": "16.1.1", "build": "20B101", "major": 16},
    {"v": "16.2",   "build": "20C65",  "major": 16},
    {"v": "16.3",   "build": "20D47",  "major": 16},
    {"v": "16.3.1", "build": "20D67",  "major": 16},
    {"v": "16.4",   "build": "20E246", "major": 16},
    {"v": "16.4.1", "build": "20E252", "major": 16},
    {"v": "16.5",   "build": "20F66",  "major": 16},
    {"v": "16.5.1", "build": "20F75",  "major": 16},
    {"v": "16.6",   "build": "20G75",  "major": 16},
    {"v": "16.6.1", "build": "20G81",  "major": 16},
    {"v": "16.7",   "build": "20H19",  "major": 16},
    {"v": "16.7.1", "build": "20H30",  "major": 16},
    # iOS 17
    {"v": "17.0",   "build": "21A329", "major": 17},
    {"v": "17.0.3", "build": "21A360", "major": 17},
    {"v": "17.1",   "build": "21B74",  "major": 17},
    {"v": "17.1.1", "build": "21B91",  "major": 17},
    {"v": "17.2",   "build": "21C62",  "major": 17},
    {"v": "17.2.1", "build": "21C66",  "major": 17},
    {"v": "17.3",   "build": "21D50",  "major": 17},
    {"v": "17.3.1", "build": "21D61",  "major": 17},
    {"v": "17.4",   "build": "21E219", "major": 17},
    {"v": "17.4.1", "build": "21E236", "major": 17},
    {"v": "17.5",   "build": "21F79",  "major": 17},
    {"v": "17.5.1", "build": "21F90",  "major": 17},
    {"v": "17.6",   "build": "21G80",  "major": 17},
    {"v": "17.6.1", "build": "21G93",  "major": 17},
    {"v": "17.7",   "build": "21H16",  "major": 17},
    # iOS 18
    {"v": "18.0",   "build": "22A3354", "major": 18},
    {"v": "18.0.1", "build": "22A3370", "major": 18},
    {"v": "18.1",   "build": "22B83",   "major": 18},
    {"v": "18.1.1", "build": "22B91",   "major": 18},
    {"v": "18.2",   "build": "22C152",  "major": 18},
    {"v": "18.2.1", "build": "22C161",  "major": 18},
    {"v": "18.3",   "build": "22D63",   "major": 18},
    {"v": "18.3.1", "build": "22D72",   "major": 18},
    {"v": "18.4",   "build": "22E240",  "major": 18},
    {"v": "18.4.1", "build": "22E252",  "major": 18},
    {"v": "18.5",   "build": "22F76",   "major": 18},
]

# ----------------------------------------------------------------------------
# Модели iPhone, начиная с iPhone X и выше, с реальными характеристиками экрана
# (физическое разрешение/scale + логический размер точек) и РЕАЛЬНЫМ диапазоном
# поддерживаемых мажорных версий iOS (ios_min..ios_max). Диапазон обязателен:
# напр. iPhone X (iPhone10,x) максимум тянет iOS 16 (не 17+), а iPhone 16
# (iPhone17,x) вышел сразу на iOS 18 — генерируем только реально существующие
# сочетания "модель + iOS".
IPHONE_DEVICES = [
    # iPhone X — максимум iOS 16.7.x, iOS 17 не поддерживает
    {"model": "iPhone10,3", "res": "1125x2436", "scale": "3.00", "wl": 375, "hl": 812, "ios_min": 15, "ios_max": 16},  # X (GSM)
    {"model": "iPhone10,6", "res": "1125x2436", "scale": "3.00", "wl": 375, "hl": 812, "ios_min": 15, "ios_max": 16},  # X (Global)
    # iPhone XS / XS Max / XR — iOS 15..18
    {"model": "iPhone11,2", "res": "1125x2436", "scale": "3.00", "wl": 375, "hl": 812, "ios_min": 15, "ios_max": 18},  # XS
    {"model": "iPhone11,6", "res": "1242x2688", "scale": "3.00", "wl": 414, "hl": 896, "ios_min": 15, "ios_max": 18},  # XS Max
    {"model": "iPhone11,8", "res": "828x1792",  "scale": "2.00", "wl": 414, "hl": 896, "ios_min": 15, "ios_max": 18},  # XR
    # iPhone 11 / Pro / Pro Max — iOS 15..18
    {"model": "iPhone12,1", "res": "828x1792",  "scale": "2.00", "wl": 414, "hl": 896, "ios_min": 15, "ios_max": 18},  # 11
    {"model": "iPhone12,3", "res": "1125x2436", "scale": "3.00", "wl": 375, "hl": 812, "ios_min": 15, "ios_max": 18},  # 11 Pro
    {"model": "iPhone12,5", "res": "1242x2688", "scale": "3.00", "wl": 414, "hl": 896, "ios_min": 15, "ios_max": 18},  # 11 Pro Max
    {"model": "iPhone12,8", "res": "750x1334",  "scale": "2.00", "wl": 375, "hl": 667, "ios_min": 15, "ios_max": 18},  # SE 2
    # iPhone 12 series — iOS 15..18
    {"model": "iPhone13,1", "res": "1080x2340", "scale": "3.00", "wl": 375, "hl": 812, "ios_min": 15, "ios_max": 18},  # 12 mini
    {"model": "iPhone13,2", "res": "1170x2532", "scale": "3.00", "wl": 390, "hl": 844, "ios_min": 15, "ios_max": 18},  # 12
    {"model": "iPhone13,3", "res": "1170x2532", "scale": "3.00", "wl": 390, "hl": 844, "ios_min": 15, "ios_max": 18},  # 12 Pro
    {"model": "iPhone13,4", "res": "1284x2778", "scale": "3.00", "wl": 428, "hl": 926, "ios_min": 15, "ios_max": 18},  # 12 Pro Max
    # iPhone 13 series — iOS 15..18
    {"model": "iPhone14,4", "res": "1080x2340", "scale": "3.00", "wl": 375, "hl": 812, "ios_min": 15, "ios_max": 18},  # 13 mini
    {"model": "iPhone14,5", "res": "1170x2532", "scale": "3.00", "wl": 390, "hl": 844, "ios_min": 15, "ios_max": 18},  # 13
    {"model": "iPhone14,2", "res": "1170x2532", "scale": "3.00", "wl": 390, "hl": 844, "ios_min": 15, "ios_max": 18},  # 13 Pro
    {"model": "iPhone14,3", "res": "1284x2778", "scale": "3.00", "wl": 428, "hl": 926, "ios_min": 15, "ios_max": 18},  # 13 Pro Max
    {"model": "iPhone14,6", "res": "750x1334",  "scale": "2.00", "wl": 375, "hl": 667, "ios_min": 15, "ios_max": 18},  # SE 3
    # iPhone 14 / Plus — iOS 16..18
    {"model": "iPhone14,7", "res": "1170x2532", "scale": "3.00", "wl": 390, "hl": 844, "ios_min": 16, "ios_max": 18},  # 14
    {"model": "iPhone14,8", "res": "1284x2778", "scale": "3.00", "wl": 428, "hl": 926, "ios_min": 16, "ios_max": 18},  # 14 Plus
    # iPhone 14 Pro / Pro Max — iOS 16..18
    {"model": "iPhone15,2", "res": "1179x2556", "scale": "3.00", "wl": 393, "hl": 852, "ios_min": 16, "ios_max": 18},  # 14 Pro
    {"model": "iPhone15,3", "res": "1290x2796", "scale": "3.00", "wl": 430, "hl": 932, "ios_min": 16, "ios_max": 18},  # 14 Pro Max
    # iPhone 15 series — iOS 17..18
    {"model": "iPhone15,4", "res": "1179x2556", "scale": "3.00", "wl": 393, "hl": 852, "ios_min": 17, "ios_max": 18},  # 15
    {"model": "iPhone15,5", "res": "1290x2796", "scale": "3.00", "wl": 430, "hl": 932, "ios_min": 17, "ios_max": 18},  # 15 Plus
    {"model": "iPhone16,1", "res": "1179x2556", "scale": "3.00", "wl": 393, "hl": 852, "ios_min": 17, "ios_max": 18},  # 15 Pro
    {"model": "iPhone16,2", "res": "1290x2796", "scale": "3.00", "wl": 430, "hl": 932, "ios_min": 17, "ios_max": 18},  # 15 Pro Max
    # iPhone 16 series — только iOS 18
    {"model": "iPhone17,3", "res": "1179x2556", "scale": "3.00", "wl": 393, "hl": 852, "ios_min": 18, "ios_max": 18},  # 16
    {"model": "iPhone17,4", "res": "1290x2796", "scale": "3.00", "wl": 430, "hl": 932, "ios_min": 18, "ios_max": 18},  # 16 Plus
    {"model": "iPhone17,1", "res": "1206x2622", "scale": "3.00", "wl": 402, "hl": 874, "ios_min": 18, "ios_max": 18},  # 16 Pro
    {"model": "iPhone17,2", "res": "1320x2868", "scale": "3.00", "wl": 440, "hl": 956, "ios_min": 18, "ios_max": 18},  # 16 Pro Max
]


def pick_device_profile(device: Optional[dict] = None) -> dict:
    """Выбирает случайное устройство и совместимую с ним РЕАЛЬНУЮ версию iOS
    (из диапазона ios_min..ios_max этой модели) с настоящим build-номером.
    Возвращает полный профиль устройства для UA и записи аккаунта.
    """
    device = device or random.choice(IPHONE_DEVICES)
    releases = [r for r in IOS_RELEASES
                if device["ios_min"] <= r["major"] <= device["ios_max"]]
    rel = random.choice(releases)
    ios_dotted = rel["v"]
    return {
        "model": device["model"],
        "res": device["res"],
        "scale": device["scale"],
        "w_logical": device["wl"],
        "h_logical": device["hl"],
        "os_version": ios_dotted,          # "16.4.1"
        "os_ver_dotted": ios_dotted,       # дублируем для совместимости
        "os_build": rel["build"],          # "20E252"
        "ios_ver": ios_dotted.replace(".", "_"),  # "16_4_1" (формат UA)
    }


def build_ios_user_agent(profile: Optional[dict] = None) -> str:
    """Собирает User-Agent iOS-клиента Instagram по профилю устройства
    (реальная модель + реальная поддерживаемая iOS). Версия приложения/build
    запинены, поэтому UA всегда согласован с bloks_versioning_id."""
    p = profile or pick_device_profile()
    return (
        f"Instagram {PINNED_IG_VERSION} ({p['model']}; iOS {p['ios_ver']}; "
        f"en_US; en; scale={p['scale']}; {p['res']}; "
        f"{PINNED_IG_BUILD}) AppleWebKit/420+"
    )


# Дефолтный UA из свежего дампа (используется как фолбэк / для обратной
# совместимости). В самой регистрации на каждый аккаунт генерируется свой.
PINNED_USER_AGENT = (
    f"Instagram {PINNED_IG_VERSION} (iPhone17,1; iOS 18_5; en_US; en; "
    f"scale=3.00; 1206x2622; {PINNED_IG_BUILD}) AppleWebKit/420+"
)
USER_AGENT = PINNED_USER_AGENT

# client_doc_id = persisted query hash GraphQL-ОПЕРАЦИИ (не отдельного экрана).
# В сборке 437.0.0.22.50 их ровно два — по типу корневого запроса bloks:
#   • BKAppRootQuery    — экранные fetch-запросы (app_id БЕЗ суффикса .async),
#     x-root-field-name = bloks_app
#   • BKActionRootQuery — action-запросы (app_id заканчивается на .async),
#     x-root-field-name = bloks_action
# Тип определяется по суффиксу .async у app_id (см. post_graphql_bloks).
CLIENT_DOC_ID_APP = "252507231518090881989663115110"     # BKAppRootQuery
CLIENT_DOC_ID_ACTION = "398678489412499626688914657582"  # BKActionRootQuery

# Обратная совместимость со старыми именами (используются в вызовах ниже).
# Теперь оба указывают на актуальные хэши сборки 437.0.0.22.50; фактический
# выбор всё равно делает post_graphql_bloks по суффиксу .async.
CLIENT_DOC_ID_DEFAULT = CLIENT_DOC_ID_ACTION
CLIENT_DOC_ID_CONTACTPOINT = CLIENT_DOC_ID_APP

# bk_context отправляется во всех GraphQL запросах



# ============================================================================
# Утилиты
# ============================================================================
def extract_confirmation_code(raw_text: str) -> Optional[str]:
    """
    Достаёт confirmation_code, который сервер возвращает в ОТВЕТЕ step5
    внутри подготовленного reg_info. Значение экранировано произвольное
    число раз (JSON-в-JSON), поэтому вокруг ':' и знач����ния допускаем
    любое количество '\\' и '"'.

    Отбрасываем служебные null/true/false, чтобы не схватить
    confirmation_code":null из других мест ответа.
    """
    if not raw_text:
        return None

    # confirmation_code  <��ю��ые \ и ">  :  <любые \ и ">  ЗНАЧЕНИЕ
    pattern = r'confirmation_code[\\"]*:[\\"]*([A-Za-z0-9_-]+)'
    candidates = [
        c for c in re.findall(pattern, raw_text)
        if c not in ("null", "true", "false") and not c.isspace()
    ]
    if not candidates:
        return None

    # Если одно и то же значение встречается в нескольких местах — берём самое
    # частое; при равенстве — самое длинное (реальный код, а не обрывок).
    counter = Counter(candidates)
    most_common = counter.most_common()
    most_common.sort(key=lambda kv: (-kv[1], -len(kv[0])))
    return most_common[0][0]


def gen_device_id() -> str:
    """B2F5B40E-6480-4A6B-B9DB-341139E4A1A1 - формат iOS device id (uppercase UUID)."""
    return str(uuid.uuid4()).upper()


def gen_waterfall_id() -> str:
    """cc588db7dc77467488278013d3c96310 - 32 hex без дефисов."""
    return uuid.uuid4().hex


def gen_cloud_trust_token() -> str:
    """Два UPPERCASE UUID встык, без разделителя (как в реальном дампе: <UUID><UUID>).
    Исправляет старый баг с no-op .replace('-', '-', 4)."""
    return str(uuid.uuid4()).upper() + str(uuid.uuid4()).upper()


def gen_aacjid() -> str:
    """89f81fb9-20ea-4178-afe7-d9d8ec92d6e6 - обычный UUID."""
    return str(uuid.uuid4())


def gen_machine_id() -> str:
    """TBE_<24 base64-ish символов>."""
    import secrets, base64
    return "TBE_" + base64.urlsafe_b64encode(secrets.token_bytes(18)).decode().rstrip("=")[:24]


def gen_aaccs() -> str:
    """
    Уникальный на аккаунт anti-abuse client-токен (поле "aaccs" в блоке aac).

    Формат как в реальном дампе: 43 символа base64url без padding (= 32 байта).
    КРИТИЧНО для уникальности: если слать один и тот же aaccs во всех
    регистрациях, Instagram склеивает их в одного актора независимо от IP.
    """
    import secrets, base64
    return base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")


# ============================================================================
# Низкоуровневые транспортные функции
# ============================================================================


def signed_body(params_obj: Any) -> str:
    """
    Для logged-out запросов client отправляет body вида:

        signed_body=SIGNATURE.<url_encoded_json>

    Где SIGNATURE - литеральная строка (не HMAC). Это видно в дампе файла
    2__async_action.txt - там реальный body начинается с "signed_body=SIGNATURE.".
    """
    return "signed_body=SIGNATURE." + quote(json.dumps(params_obj, separators=(",", ":")), safe="")


def post_async_action(
        session: requests.Session,
        app_id: str,
        params_obj: Dict[str, Any],
        headers: Dict[str, str],
) -> Dict[str, Any]:
    """POST на /api/v1/bloks/async_action/<app_id>/ ."""
    url = f"{INSTAGRAM_HOST}/api/v1/bloks/async_action/{app_id}/"
    body = signed_body(params_obj)
    h = dict(headers)
    h["x-fb-friendly-name"] = "bloks/async_action/"
    h["content-length"] = str(len(body))
    r = session.post(url, data=body, headers=h, timeout=30)
    return _parse_response(r, app_id)


def post_bloks_app(
        session: requests.Session,
        app_id: str,
        params_obj: Dict[str, Any],
        headers: Dict[str, str],
) -> Dict[str, Any]:
    """POST на /api/v1/bloks/apps/<app_id>/ (используется только для name_ig_and_soap)."""
    url = f"{INSTAGRAM_HOST}/api/v1/bloks/apps/{app_id}/"
    body = signed_body(params_obj)
    h = dict(headers)
    h["x-fb-friendly-name"] = "api"
    h["content-length"] = str(len(body))
    r = session.post(url, data=body, headers=h, timeout=30)
    return _parse_response(r, app_id)


def post_graphql_bloks(
        session: requests.Session,
        app_id: str,
        server_params: Dict[str, Any],
        client_input_params: Dict[str, Any],
        headers: Dict[str, str],
        client_doc_id: str = CLIENT_DOC_ID_DEFAULT,
        infra_params: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    POST /graphql_www для BKAppRootQuery / BKActionRootQuery
    (тип выбирается автоматически по суффиксу .async у app_id).

    Структура variables (как в дампе):
        {
          "bk_context": {...},
          "params": {
            "params": "<json string with server_params + client_input_params>",
            "bloks_versioning_id": BLOKS_VERSION_ID,
            "app_id": <app_id>,
            "infra_params": {"device_id": ...}
          }
        }

    Внутреннее поле "params" - это JSON-строка, содержащая ещё одну JSON-строку
    (двойное кодирование), внутри которой server_params и client_input_params.
    Так делает реальный клиент Instagram.
    """
    # Внутренний JSON
    inner = {
        "server_params": server_params,
        "client_input_params": client_input_params,
    }
    # Двойное кодирование как в дампе
    params_str = json.dumps({"params": json.dumps(inner, separators=(",", ":"))}, separators=(",", ":"))

    variables = {
        "bk_context": BK_CONTEXT,
        "params": {
            "params": params_str,
            # bloks_versioning_id берём из заголовков (= build-профиль аккаунта),
            # чтобы он совпадал с версией приложения в UA. Fallback - глобаль.
            "bloks_versioning_id": headers.get("x-bloks-version-id", PINNED_BLOKS_VERSION_ID),
            "app_id": app_id,
            "infra_params": infra_params or {"device_id": headers.get("x-ig-device-id", "")},
        },
    }

    # В сборке 437.0.0.22.50 имя запроса, root-field и client_doc_id зависят от
    # типа bloks-запроса и определяются по суффиксу .async у app_id:
    #   • action (app_id ...async)  -> BKActionRootQuery / bloks_action / ACTION doc
    #   • app   (экранный fetch)     -> BKAppRootQuery    / bloks_app    / APP doc
    # Раньше для всего слался IGBloksAppRootQuery + bloks_action, что не совпадало
    # с реальным клиентом. Значение client_doc_id из аргумента игнорируем и
    # выбираем строго по типу — так оно всегда согласовано с friendly-name.
    is_action = app_id.endswith(".async")
    if is_action:
        friendly_name = f"BKActionRootQuery-{app_id}"
        root_field_name = "bloks_action"
        resolved_doc_id = CLIENT_DOC_ID_ACTION
    else:
        friendly_name = f"BKAppRootQuery-{app_id}"
        root_field_name = "bloks_app"
        resolved_doc_id = CLIENT_DOC_ID_APP

    form = {
        "method": "post",
        "pretty": "false",
        "format": "json",
        "server_timestamps": "true",
        "locale": "en_US",
        "purpose": "fetch",
        "fb_api_req_friendly_name": friendly_name,
        "client_doc_id": resolved_doc_id,
        "enable_canonical_naming": "true",
        "enable_canonical_variable_overrides": "true",
        "enable_canonical_naming_ambiguous_type_prefixing": "true",
        "variables": json.dumps(variables, separators=(",", ":")),
    }

    body = urlencode(form)
    h = dict(headers)
    h["x-fb-friendly-name"] = friendly_name
    h["x-root-field-name"] = root_field_name
    h["x-graphql-client-library"] = "pando"
    h["x-graphql-request-purpose"] = "fetch"
    h["content-length"] = str(len(body))

    r = session.post(f"{INSTAGRAM_HOST}/graphql_www", data=body, headers=h, timeout=30)
    return _parse_response(r, app_id)


def _parse_response(r: requests.Response, app_id: str) -> Dict[str, Any]:
    """Унифицированный парсер ответа со всех endpoint'ов."""
    out: Dict[str, Any] = {
        "status_code": r.status_code,
        "app_id": app_id,
        "raw": "",
        "json": None,
        "reg_context": None,
        "headers": dict(r.headers),
    }
    try:
        out["raw"] = r.text
        out["json"] = r.json()
    except Exception:
        pass

    # Извлечь reg_context из любого места ответа (включая вложенные строки)
    out["reg_context"] = _extract_reg_context(out["raw"])
    return out


def _extract_reg_context(raw_text: str) -> Optional[str]:
    """
    Достаёт reg_context из ответа сервера.

    ПОЧЕМУ старая ве��с��я всегда возвращала NONE:
    Сервер НЕ присылает reg_context как ��лоское поле "reg_context":"AV...".
    Он зашивает его в подготовленный Bloks-шаблон следующего действия:

        (f4i (dkc ... "login_surface" "login_entry_point" "reg_context")
             (dkc ... "login_home"    "logged_out"        "AV...|regm"))

    То есть reg_context — это ПОСЛЕДНЕЕ значение в (dkc <values>), которое
    стоит сразу после значения login_entry_point ("logged_out"). Сам токен —
    длинный base64url-блоб (~10 000 символов), который ОБЯЗАТЕЛЬНО
    заканчивается маркером "|regm". В дампе токен может быть разбит
    переносами строк (это артефакт форматирования) — поэтому из найденного
    значения убираются все пробельные символы.

    Старый парсер искал только "reg_context":"...", такого поля в ответе нет,
    поэтому self.reg_context оставался пустым и шаг name_ig_and_soap (step8)
    падал с transition_failure_REG_IG_NAME_SOAP_TO_NEXT.
    """
    if not raw_text:
        return None

    # --- Стратегия 1: плоское JSON-поле (на случай если оно где-то есть) ---
    json_patterns = [
        r'\\\\"reg_context\\\\":\\\\"([^"\\]{20,})\\\\"',  # двойной escape
        r'\\"reg_context\\":\\"([^"\\]{20,})\\"',          # одинарный escape
        r'"reg_context":"([^"]{20,})"',                     # обычный JSON
    ]
    for pat in json_patterns:
        found = re.findall(pat, raw_text)
        if found:
            # берём самый длинный — настоящий reg_context крупный
            return max(found, key=len)

    # --- Стратегия 2: Bloks-шаблон, токен сразу после login_entry_point ---
    # logged_out, затем экранированные кавычки/бэкслеши/пробелы, затем токен,
    # заканчивающийся на |regm.
    m = re.search(
        r'logged_out[\\"\s]+([A-Za-z0-9_\-][A-Za-z0-9_\-\s]{200,}\|regm)',
        raw_text,
    )
    if m:
        return re.sub(r"\s+", "", m.group(1))

    # --- Стратегия 3: запасной вариант — единственный токен, кончающийся |regm ---
    cands = re.findall(r"([A-Za-z0-9_\-][A-Za-z0-9_\-\s]{200,}\|regm)", raw_text)
    cands = [re.sub(r"\s+", "", c) for c in cands]
    if len(cands) == 1:
        return cands[0]

    return None


# ============================================================================
# Высокоуровневый поток регистрации
# ============================================================================

class InstagramRegistration:
    """
    Один экземпляр = одна попытка регистрации.

    Использование:

        reg = InstagramRegistration(
            email="test@outlook.com",
            email_password="...",            # пароль ящика Outlook
            ig_password="MyPass123!",
            first_name="John",
            last_name="Doe",
            birthday=(2002, 6, 26),
            username="john_doe",
            email_client_id="...",           # client_id Outlook (graph2imap)
            email_refresh_token="...",       # refresh_token Outlook (graph2imap)
        )
        ok = reg.run()
    """

    def __init__(
            self,
            email: str,
            email_password: str,  # пароль от почтового ящика Outlook
            ig_password: str,
            first_name: str,
            last_name: str,
            birthday: tuple,  # (year, month, day)
            username: str,  # будущий @username Instagram
            email_client_id: str = "",       # client_id Outlook для graph2imap
            email_refresh_token: str = "",   # refresh_token Outlook для graph2imap
            mail_client=None,                # готовый клиент почты (Outlook/AnyMessage); если None - создаётся OutlookClient
            sms_client=None,  # <-- НОВОЕ: клиент Textverified
            phone: str = "",
            email_folder: str = "INBOX",
            device_id: Optional[str] = None,
            waterfall_id: Optional[str] = None,
            code_wait_timeout: int = 30,
            code_poll_interval: float = 3.0,
            proxy: Optional[str] = None,
            user_agent: str = None,
            step_delay_min: float = 8.0,    # мин. задержка между шагами (сек)
            step_delay_max: float = 22.0    # макс. задержка ��������������ежду шагами (сек)
    ):
        # Один согласованный build-профиль на аккаунт: версия приложения в UA,
        # bloks_versioning_id и app_id берутся из ОДНОЙ сборки (не рассинхронятся).
        # ЗАПИНЕННАЯ сборка: не полагаемся на случайный pick_build_profile(),
        # а жёстко фиксируем версию iOS/приложения из дампов, чтобы UA,
        # bloks_versioning_id и app_id всегда были согласованы между собой и
        # одинаковы для регистрации и warmup. Это устраняет рассинхрон
        # "создан на одной сборке — используется на другой".
        self.build_profile = pick_build_profile()
        self.build_profile["ig_version"] = PINNED_IG_VERSION
        self.build_profile["bloks_versioning_id"] = PINNED_BLOKS_VERSION_ID
        self.build_profile["ig_app_id"] = PINNED_IG_APP_ID
        self.bloks_versioning_id = PINNED_BLOKS_VERSION_ID
        self.ig_app_id = PINNED_IG_APP_ID
        # Метаданные сборки для экспорта аккаунта (блок "app" в записи xlsx).
        # account_store не может импортировать эти константы (циклический импорт),
        # поэтому кладём их на объект регистрации.
        self.app_ig_version = PINNED_IG_VERSION_SHORT   # "447"
        self.app_version = PINNED_APP_VERSION           # "447.0.0"
        self.app_build_number = PINNED_IG_BUILD         # "1065993616"
        # Профиль устройства выбирается ОДИН раз на аккаунт: реальная модель
        # iPhone (X и выше) + реально поддерживаемая ею версия iOS с настоящим
        # build-номером. Одно и то же устройство используется и для регистрации,
        # и для warmup (не плавает), и записывается в ua_profile аккаунта.
        self.device_profile = pick_device_profile()
        self.user_agent = user_agent or build_ios_user_agent(self.device_profile)
        self.build_profile["user_agent"] = self.user_agent
        self.proxy = proxy                  # сохраняем для записи в xlsx
        self.step_delay_min = step_delay_min
        self.step_delay_max = step_delay_max
        self.confirmation_code = ""
        self.enc_key_id: int = 58
        self.enc_pub_key_b64: str = ""
        self.email = email
        self.email_password = email_password
        self.email_client_id = email_client_id
        self.email_refresh_token = email_refresh_token
        self.email_folder = email_folder
        self.ig_password = ig_password
        self.username = username
        self.first_name = first_name
        self.last_name = last_name
        self.full_name = f"{first_name} {last_name}".strip()
        self.birthday_year, self.birthday_month, self.birthday_day = birthday
        self.session = requests.Session()
        # ВАЖНО: прокси навешиваем СРАЗУ, до любых сетевых вызовов (в т.ч. до
        # resolve_geo ниже). Иначе гео-lookup уходит с IP раннера, и locale/
        # timezone аккаунта берутся из гео твоей машины, а не из прокси.
        if proxy:
            configure_session_proxy(self.session, proxy)
        # Генерируем уникальные идентификаторы для этой рег������страции
        self.device_id = device_id or gen_device_id()
        self.waterfall_id = waterfall_id or gen_waterfall_id()
        self.family_device_id = gen_family_device_id()
        self.cloud_trust_token = gen_cloud_trust_token()
        # Идентификаторы, нужные формату экспорта аккаунта (блок "device").
        # В самих запросах регистрации они не участвуют, но импортирующий
        # инструмент ждёт их и требует внутренней согласованности, поэтому
        # генерируем их один раз здесь (стабильны на весь жизненный цикл reg).
        self.guid = str(uuid.uuid4()).upper()
        self.phone_id = str(uuid.uuid4()).lower()
        self.pigeon_session = str(uuid.uuid4()).upper()
        self.fb_anon_id = "XZ" + str(uuid.uuid4()).upper()
        self.reg_flow_id = str(uuid.uuid4()).lower()
        self.geo = resolve_geo(self.session, fallback_country=_FALLBACK_TZ)
        self.aacjid = gen_aacjid()
        self.machine_id = gen_machine_id()
        self.aac_init_ts = int(time.time())
        self.aaccs = gen_aaccs()  # УНИКАЛЬНЫЙ на аккаунт (раньше был один из дампа)
        self.qpl_marker_id = 36707139  # одинаковый для всех запросов в дампе
        self.qpl_instance_id_base = int(time.time() * 1000) * 1000

        # Состояние, накапливаемое между запросами

        self.mid: str = ""  # x-mid из cookie/header после первого запроса
        # Авторизационные значения, которые сервер отдаёт в заголовках ответа.
        # Их НЕ всегда отдаёт именно финальный шаг - поэтому ловим на каждом шаге.
        # Статус записи в xlsx:
        #   "added" | "banned" | "no_bearer" | "not_approved" | "not_added".
        # По умолчанию "not_added" (если до шага сохранения не дошли).
        self.xlsx_status: str = "not_added"
        # Подготовленная запись аккаунта, ОТЛОЖЕННАЯ до APPROVED. Пишем в xlsx
        # только после успешного завершения онбординга (consent APPROVED),
        # чтобы в таблицу попадали лишь полностью готовые аккаунты.
        self._pending_record: Optional[Dict[str, Any]] = None
        self.www_claim: str = ""        # x-ig-set-www-claim
        self.bearer: str = ""           # ig-set-authorization ("Bearer IGT:2:...")
        self.ds_user_id: str = ""       # ig-set-ig-u-ds-user-id
        self.reg_context: Optional[str] = None  # шифрованный state между шагами
        # ig-u-rur из ответа create.account (нужен как заголовок ig-u-rur в
        # авторизованных запросах пост-регистрационного NUX и warmup).
        self.rur: str = ""
        # Идентификаторы созданного аккаунта (парсим из ответа create.account):
        #   created_user_id — IG pk (= ds_user_id), created_fb_uid — family uid.
        self.created_user_id: str = ""
        self.created_fb_uid: str = ""
        # experience_id онбординга new_users_meta_flow (для privacy-consent).
        self.experience_id: str = ""
        # Финальный флаг: пришёл ли APPROVED на consent ACTION (главный признак,
        # что онбординг закрыт и аккаунт не partially_created).
        self.nux_consent_approved: bool = False
        self.text_input_id: Optional[int] = None
        self.encrypted_password_cached: Optional[str] = None  # шифруем 1 раз на шаге 6,
        # переиспользуем на шаге 11

        # Настройки ожидания кода
        self.code_wait_timeout = code_wait_timeout
        self.code_poll_interval = code_poll_interval

        # Если клиент почты передан явно (например AnyMessage) - используем его,
        # иначе по умолчанию работаем с Outlook через graph2imap.
        if mail_client is not None:
            self.mail_client = mail_client
        else:
            self.mail_client = OutlookClient(
                client_id=email_client_id,
                refresh_token=email_refresh_token,
            )

        self.sms_client = sms_client
        # Нормализуем номер в ДВА канонических вида, как в реальном дампе:
        #   reg_info.contactpoint      -> E.164 c "+" и кодом страны  (+15402599731)
        #   server_params.phone        -> НАЦИОНАЛЬНЫЙ номер без кода  (5402599731)
        # Раньше в оба места шёл один и тот же self.phone, из-з�� чего contactpoint
        # был без "+"/кода страны и Instagram не отправлял SMS.
        self.phone = phone
        self.phone_e164, self.phone_national = self._normalize_phone(phone)
        # Код страны как целое число (для client_input_params.country_code), напр. 1 для US.
        _cc_digits = self.phone_e164[1:-len(self.phone_national)] if self.phone_national else ""
        self.phone_country_code = int(_cc_digits) if _cc_digits else 1
        # (прокси уже навешен на self.session выше, до resolve_geo)
    # ----- helpers ----------------------------------------------------------

    @staticmethod
    def _normalize_phone(phone: str) -> tuple:
        """Приводит номер к двум формам, которые ждёт Instagram (см. дамп).

        Textverified обычно отдаёт US-номер как 10 цифр (5402599731) либо с
        кодом (15402599731 / +15402599731). Возвращаем:
          e164     -> "+<country><national>"  например "+15402599731"
          national -> "<national>" без кода страны, например "5402599731"

        Логика для US/CA (код 1): последние 10 цифр = national, всё остальное = код.
        Для других стран берём общий подход: если начинается с "+", код берём
        как всё до последних 10 цифр.
        """
        raw = str(phone or "").strip()
        has_plus = raw.startswith("+")
        digits = "".join(ch for ch in raw if ch.isdigit())
        if not digits:
            return raw, raw

        # US/CA: 11 цифр вида 1XXXXXXXXXX -> код "1", national = последние 10.
        if len(digits) == 11 and digits[0] == "1":
            cc, national = "1", digits[1:]
        elif len(digits) == 10 and not has_plus:
            # 10 цифр без "+" трактуем ��ак US national.
            cc, national = "1", digits
        else:
            # Общий случай: национальным считаем последние 10 цифр.
            national = digits[-10:]
            cc = digits[:-10] or "1"

        e164 = "+" + cc + national
        return e164, national

    def _rand_sleep(self, lo: float = None, hi: float = None) -> None:
        """Случайная задержка между шагами, чтобы аккаунты не создавались синхронно."""
        lo = self.step_delay_min if lo is None else lo
        hi = self.step_delay_max if hi is None else hi
        if hi < lo:
            lo, hi = hi, lo
        delay = random.uniform(lo, hi)
        print(f"[sleep] пауза {delay:.1f}s")
        time.sleep(delay)

    def _aac_string(self) -> str:
        """aac - JSON-строка внутри JSON-строки server_params/client_input_params."""
        return json.dumps({
            "aac_init_timestamp": self.aac_init_ts,
            "aacjid": self.aacjid,
            "aaccs": self.aaccs,
        }, separators=(",", ":"))

    def _flow_info(self) -> str:
        return json.dumps(
            {"flow_name": "new_to_family_ig_default", "flow_type": "ntf"},
            separators=(",", ":"),
        )

    def _reg_info(
            self,
            first_name: Optional[str] = None,
            last_name: Optional[str] = None,
            full_name: Optional[str] = None,
            contactpoint: Optional[str] = None,
            confirmation_code: Optional[str] = None,
            birthday: Optional[str] = None,
            username: Optional[str] = None,
            encrypted_password: Optional[str] = None,
            should_save_password: Optional[bool] = None,
            contactpoint_type: str = "email",
    ) -> str:
        """reg_info максимально приближенный к iOS дампу.

        ВАЖНО: contactpoint_type задаётся ЯВНО ("phone" или "email").
        Раньше он вычислялся как ("email" if contactpoint else None), из-за чего
        при регистрации по номеру телефона тип всё равно был "email" — Instagram
        считал флоу email-регистрацией и НЕ отправлял SMS.
        """
        info = {
            "first_name": first_name,
            "last_name": last_name,
            "full_name": full_name,
            "contactpoint": contactpoint,
            "ar_contactpoint": None,
            "attempted_empty_last_name": None,
            "contactpoint_type": contactpoint_type if contactpoint else None,
            "is_using_unified_cp": False,
            "unified_cp_screen_variant": "control",
            "is_cp_auto_confirmed": False,
            "is_cp_auto_confirmable": False,
            "is_cp_claimed": False,
            "confirmation_code": confirmation_code,
            "birthday": birthday,
            "birthday_derived_from_age": None,
            "age_range": None,
            "did_use_age": None,
            "os_shared_age_range": None,
            "gender": None,
            "use_custom_gender": False,
            "custom_gender": None,
            "encrypted_password": encrypted_password,
            "username": username,
            "username_prefill": None,
            "accounts_list_client": None,
            "fb_conf_source": None,
            "device_id": self.device_id,
            "ig4a_qe_device_id": None,
            "family_device_id": None,
            "fdid_available_on_start": False,
            "fdid_rid_available_on_start": False,
            "asdid_available_on_start": True,
            "user_id": None,
            "skip_slow_rel_check": True,
            "machine_id": self.machine_id,
            "profile_photo": None,
            "profile_photo_id": None,
            "profile_photo_upload_id": None,
            "avatar": None,
            "email_oauth_token_no_contact_perm": None,
            "email_oauth_token": None,
            "email_oauth_tokens": None,
            "sign_in_with_google_email": None,
            "should_skip_two_step_conf": None,
            "openid_tokens_for_testing": None,
            "encrypted_msisdn": None,
            "headers_last_infra_flow_id": None,
            "headers_flow_id": None,
            "was_headers_prefill_available": None,
            "sso_enabled": None,
            "existing_accounts": None,
            "used_ig_birthday": None,
            "create_new_to_app_account": None,
            "skip_session_info": None,
            "ck_error": None,
            "ck_id": None,
            "ck_nonce": None,
            "should_save_password": should_save_password,
            "fb_access_token": None,
            "is_msplit_reg": None,
            "is_spectra_reg": None,
            "dema_account_consent_given": None,
            "spectra_entry_source": None,
            "spectra_reg_token": None,
            "spectra_reg_guardian_id": None,
            "spectra_reg_guardian_logged_in_context": None,
            "spectra_requester_user_id": None,
            "user_id_of_msplit_creator": None,
            "msplit_creator_nonce": None,
            "dma_data_combination_consent_given": None,
            "xapp_accounts": None,
            "fb_device_id": None,
            "fb_machine_id": None,
            "ig_device_id": None,
            "ig_machine_id": None,
            "should_skip_nta_upsell": None,
            "big_blue_token": None,
            "caa_reg_flow_source": "login_home_native_integration_point",
            "ig_authorization_token": None,
            "full_sheet_flow": False,
            "crypted_user_id": None,
            "is_ca_late_teen": None,
            "is_early_teen": None,
            "is_caa_perf_enabled": True,
            "is_preform": True,
            "should_show_rel_error": False,
            "ignore_suma_check": False,
            "dismissed_login_upsell_with_cna": False,
            "ignore_existing_login": False,
            "ignore_existing_login_from_suma": False,
            "ignore_existing_login_after_errors": False,
            "suggested_first_name": None,
            "suggested_last_name": None,
            "suggested_full_name": None,
            "frl_authorization_token": None,
            "post_form_errors": None,
            "skip_step_without_errors": False,
            "existing_account_exact_match_checked": False,
            "existing_account_fuzzy_match_checked": False,
            "email_oauth_exists": False,
            "confirmation_code_send_error": None,
            "consent_jurisdiction_at_gate": None,
            "consent_jurisdiction_at_inflow": None,
            "pc_enforcement_outcome": None,
            "pc_inflow_decision": None,
            "is_too_young": False,
            "source_account_type": None,
            "whatsapp_installed_on_client": False,
            "confirmation_medium": None,
            "source_credentials_type": None,
            "source_cuid": None,
            "source_account_reg_info": None,
            "soap_creation_source": None,
            "source_account_type_to_reg_info": None,
            "registration_flow_id": "d433c8b1-2a04-4621-9c97-ee308420c615",
            "should_skip_youth_tos": False,
            "is_youth_regulation_flow_complete": False,
            "is_on_cold_start": False,
            "email_prefilled": False,
            "cp_confirmed_by_auto_conf": False,
            "in_sowa_experiment": False,
            "conf_allow_back_nav_after_change_cp": None,
            "conf_bouncing_cliff_screen_type": None,
            "conf_show_bouncing_cliff": None,
            "eligible_to_flash_call_in_ig4a": False,
            "eligible_to_mo_sms_in_ig4a": False,
            "mo_sms_ent_id": None,
            "flash_call_permissions_status": None,
            "gms_incoming_call_retriever_eligibility": None,
            "attestation_result": None,
            "request_data_and_challenge_nonce_string": None,
            "confirmed_cp_and_code": None,
            "notification_callback_id": None,
            "reg_suma_state": 0,
            "is_msplit_neutral_choice": False,
            "msg_previous_cp": None,
            "ntp_import_source_info": None,
            "youth_consent_decision_time": None,
            "sk_pipa_consent_given": None,
            "should_show_spi_before_conf": True,
            "google_oauth_account": None,
            "is_reg_request_from_ig_suma": False,
            "is_toa_reg": False,
            "is_threads_public": False,
            "spc_import_flow": False,
            "caa_play_integrity_attestation_result": None,
            "client_known_key_hash": None,
            "flash_call_provider": None,
            "is_in_gms_experience": None,
            "flash_call_nonce_prefix_details": None,
            "spc_birthday_input": False,
            "failed_birthday_year_count": None,
            "user_presented_medium_source": None,
            "user_opted_out_of_ntp": None,
            "is_from_registration_reminder": False,
            "show_youth_reg_in_ig_spc": False,
            "fb_suma_is_high_confidence": None,
            "fb_email_login_upsell_skip_suma_post_tos": False,
            "fb_suma_is_from_email_login_upsell": False,
            "fb_suma_is_from_phone_login_upsell": False,
            "should_prefill_cp_in_ar": None,
            "ig_partially_created_account_user_id": None,
            "ig_partially_created_account_nonce": None,
            "ig_partially_created_account_nonce_expiry": None,
            "force_sessionless_nux_experience": False,
            "has_seen_suma_landing_page_pre_conf": False,
            "has_seen_suma_candidate_page_pre_conf": False,
            "has_seen_confirmation_screen": False,
            "suma_on_conf_threshold": -1,
            "should_show_error_msg": True,
            "th_profile_photo_token": None,
            "attempted_silent_auth_in_fb": False,
            "attempted_silent_auth_in_ig": False,
            "sa_prefetch_callback_id": None,
            "cp_suma_results_map": None,
            "source_username": None,
            "next_uri": None,
            "should_use_next_uri": None,
            "linking_entry_point": None,
            "fb_encrypted_partial_new_account_properties": None,
            "starter_pack_name": None,
            "starter_pack_creator_user_ids": None,
            "wa_data_bundle": None,
            "bloks_controller_source": None,
            "airwave_registration_code": None,
            "is_sessionless_nux": None,
            "login_contactpoint": None,
            "login_contactpoint_type": None,
            "should_show_bday_after_name_suggestions": None,
            "should_override_back_nav": False,
            "ig_footer_variant": "control",
            "device_network_info": None,
            "is_from_web_lite_reg_controller": None,
            "login_form_siwg_email": None,
            "account_setup_waterfall_id": None,
            "is_wanted_suma_user": False,
            "device_zero_balance_state": None,
            "wa_to_ig_merged_tos_variant": None,
            "is_in_nta_single_form": False,
            "source_account_image_asset_id": None,
            "passkey_eligible_device": None,
            "nta_control_reason": None,
            "nta_risk_type": None,
            "nta_single_form_variant": None,
            "enable_survey": None,
            "phone_prefetch_outcome": None,
            "tos_accepted_on_profile_info": None,
        }
        return json.dumps(info, separators=(",", ":"))

    def _common_server_params(self, extra: Optional[dict] = None) -> dict:
        """Параметры, общие для большинства запросов."""
        base = {
            "is_from_logged_out": 0,
            "offline_experiment_group": "caa_launch_ig",
            "family_device_id": None,
            "layered_homepage_experiment_group": "igios_layered_landing_screen_experiment_ld_with_xmds_v2",
            "INTERNAL__latency_qpl_instance_id": self.qpl_instance_id_base,
            "INTERNAL__latency_qpl_marker_id": self.qpl_marker_id,
            "cloud_trust_token": self.cloud_trust_token,
            "login_surface": "login_home",
            "login_entry_point": "logged_out",
            "waterfall_id": self.waterfall_id,
            "is_from_logged_in_switcher": 0,
            "is_platform_login": 0,
            "device_id": self.device_id,
            "access_flow_version": "pre_mt_behavior",
        }
        if extra:
            base.update(extra)
        return base

    def _common_client_params(self, extra: Optional[dict] = None) -> dict:
        base = {
            "aac": self._aac_string(),
            "network_bssid": None,
            "lois_settings": {"lois_token": ""},
        }
        if extra:
            base.update(extra)
        return base

    def _headers(self):
        return common_headers(
            self.device_id, self.mid, user_agent=self.user_agent,
            bloks_versioning_id=self.bloks_versioning_id, app_id=self.ig_app_id,
        )

    # ----- пост-регистрационный "прогрев" (login_flow) ---------------------

    def _tz_offset_seconds(self) -> int:
        """Смещение таймзоны в секундах для заголовка x-ig-timezone-offset.
        Достаё���� из self.geo (структура зависит от fingerprints.resolve_geo),
        пробуя несколько возможных ключей; при неуда��е — 0."""
        g = self.geo
        for key in ("timezone_offset", "tz_offset", "timezone_offset_seconds", "offset"):
            try:
                if isinstance(g, dict) and g.get(key) is not None:
                    return int(g[key])
                v = getattr(g, key, None)
                if v is not None:
                    return int(v)
            except Exception:
                pass
        return 0

    def _private_headers(self, nav_chain: str, json_ct: bool = False) -> dict:
        """Заголовки для авторизованных запросов приватного API i.instagram.com.
        Строятся поверх common_headers (та же запиненная сборка), плюс
        authorization/www-claim/capabilities — ровно как в дампах feed/reels."""
        h = dict(self._headers())
        if self.bearer:
            h["authorization"] = self.bearer
        if self.ds_user_id:
            h["ig-intended-user-id"] = self.ds_user_id
            h["ig-u-ds-user-id"] = self.ds_user_id
        if self.rur:
            h["ig-u-rur"] = self.rur
        h["x-ig-www-claim"] = self.www_claim or "0"
        h["x-ig-capabilities"] = PINNED_IG_CAPABILITIES
        h["x-ig-connection-type"] = "WiFi"
        h["x-fb-connection-type"] = "wifi"
        h["x-ig-timezone-offset"] = str(self._tz_offset_seconds())
        h["x-ig-nav-chain"] = nav_chain
        h["content-type"] = (
            "application/json; charset=utf-8" if json_ct
            else "application/x-www-form-urlencoded; charset=UTF-8"
        )
        return h

    @staticmethod
    def _signed_body(obj: dict) -> str:
        """signed_body=SIGNATURE.<urlencoded json>. Instagram давно не проверяет
        под��ись, но литеральный префикс 'SIGNATURE.' обязателен."""
        return "signed_body=SIGNATURE." + quote(
            json.dumps(obj, separators=(",", ":")), safe=""
        )

    def _warmup_login_flow(self) -> None:
        """Эмуляция поведения приложения СРАЗУ после создания аккаунта
        (аналог instagrapi login_flow + то, что видно в дампах 7–9).

        ЗАЧЕМ ЭТО НУЖНО:
        Реальный клиент после логина/регистрации немедленно тянет ленту
        (reels_tray cold_start + timeline cold_start_fetch) тем же устройством,
        сессией и IP. Свежий аккаунт, который "создался и исчез", не проходит
        первый серверный integrity-свип и банится ~через 30 минут. Прогрев
        делает аккаунт похожим на нормально запущенный клиент.

        ВАЖНО: выполняется той же self.session (тот же прокси/IP), с тем же
        bearer и той же запиненной сборкой, что и регистрация.
        """
        if not self.bearer:
            print("[WARMUP] пропуск: нет bearer (нечем авторизоваться)")
            return

        ds = self.ds_user_id or ""
        tz = str(self._tz_offset_seconds())
        now = time.time()
        nav_chain = (
            "BKCdsScreenViewController:"
            "com.bloks.www.caa.login.auto_login_interstitial.nonrecursive:1:"
            f"cold_start:{now:.6f}:::{now:.6f},"
            f"IGMainFeedViewController:feed_timeline:2:cold_start:{now:.6f}:::{now:.6f}"
        )
        tray_session_id = uuid.uuid4().hex

        # 1) feed/reels_tray/ (cold_start) — signed_body JSON
        try:
            body = self._signed_body({
                "reason": "cold_start",
                "_uuid": self.device_id,
                "tray_session_id": tray_session_id,
                "timezone_offset": tz,
                "request_id": f"{ds}_{str(uuid.uuid4()).upper()}",
            })
            h = self._private_headers(nav_chain, json_ct=True)
            h["content-length"] = str(len(body))
            r = self.session.post(
                f"{INSTAGRAM_HOST}/api/v1/feed/reels_tray/",
                data=body, headers=h, timeout=20,
            )
            print(f"[WARMUP] reels_tray -> HTTP {r.status_code}")
        except Exception as e:
            print(f"[WARMUP] reels_tray ошибка: {type(e).__name__}: {e}")

        self._rand_sleep(1.5, 4.0)

        # 2) feed/timeline/ (cold_start_fetch) — form-urlencoded
        try:
            session_id = f"{ds}_{str(uuid.uuid4()).upper()}"
            request_id = f"{ds}_{str(uuid.uuid4()).upper()}"
            form = {
                "has_camera_permission": "0",
                "feed_view_info": "[]",
                "reason": "cold_start_fetch",
                "is_pull_to_refresh": "0",
                "cancel_ongoing_fetch": "0",
                "is_async_ads_double_request": "0",
                "is_async_ads_rti": "0",
                "is_async_ads_in_headload_enabled": "0",
                "has_seen_aart_on": "0",
                "battery_level": "85",
                "timezone_offset": tz,
                "device_id": self.device_id,
                "family_device_id": self.family_device_id,
                "_uuid": self.device_id,
                "request_id": request_id,
                "session_id": session_id,
                "is_charging": "0",
                "is_dark_mode": "0",
                "will_sound_on": "0",
                "bloks_versioning_id": self.bloks_versioning_id,
            }
            body = urlencode(form)
            h = self._private_headers(nav_chain, json_ct=False)
            h["content-length"] = str(len(body))
            r = self.session.post(
                f"{INSTAGRAM_HOST}/api/v1/feed/timeline/",
                data=body, headers=h, timeout=20,
            )
            print(f"[WARMUP] timeline -> HTTP {r.status_code}")
        except Exception as e:
            print(f"[WARMUP] timeline ошибка: {type(e).__name__}: {e}")

    # ----- завершение NUX (снятие partially_created) -----------------------
    #
    # КЛЮЧЕВОЕ ОТКРЫТИЕ (из дампов реального клиента после create.account):
    # аккаунт после step10 остаётся в состоянии "partially_created" / незавершённого
    # онбординга new_to_family (ntf). Ответ create.account содержит
    # partially_created_account_{user_id,nonce,nonce_expiry} и приказ открыть
    # экран profilephoto. Реальный клиент ДОЗАКРЫВАЕТ регистрацию тремя
    # авторизованными запросами на /graphql_www:
    #   1) com.bloks.www.bloks.caa.registration.profile.async  (пропуск фот������)
    #   2) com.bloks.www.bloks.caa.reg.transition.async         (переход ntf)
    #   3) com.bloks.www.privacy.consent.prompt.action          (approve consent)
    # Без них свежий аккаунт вычищается первым integrity-свипом (~30 минут).
    # Между этими запросами НЕ должно быть больших пауз (мы пропускаем экран
    # фото, поэтому 176-секундной ��а��зы из дампа тут быть не должно).

    def _graphql_authed_headers(self, client_endpoint: str, nav_chain: str) -> dict:
        """Заголовки авторизованного /graphql_www ��апроса (после логина).
        Добавляет authorization / ig-intended-user-id / ig-u-ds-user-id /
        ig-u-rur / www-claim к базовым заголовкам запиненной сборк��."""
        h = dict(self._headers())
        if self.bearer:
            h["authorization"] = self.bearer
        if self.ds_user_id:
            h["ig-intended-user-id"] = self.ds_user_id
            h["ig-u-ds-user-id"] = self.ds_user_id
        if self.rur:
            h["ig-u-rur"] = self.rur
        h["x-ig-www-claim"] = self.www_claim or "SKIP"
        h["x-ig-client-endpoint"] = client_endpoint
        h["x-ig-nav-chain"] = nav_chain
        h["x-ig-timezone-offset"] = str(self._tz_offset_seconds())
        h["priority"] = "u=2, i"
        # В свежих дампах сборки 437.0.0.22.50 заголовка x-client-doc-id НЕТ:
        # persisted-query резолвится по полю client_doc_id в теле запроса (его
        # проставляет post_graphql_bloks по типу запроса). Глобальный заголовок
        # с одним doc_id рассинхронил бы bloks_app-экраны, поэтому не шлём его.
        # x-ig-bloks-serialize-payload включает сериализацию bloks-ответа,
        # content-type для graphql — form-urlencoded.
        h["x-ig-bloks-serialize-payload"] = "true"
        h["content-type"] = "application/x-www-form-urlencoded; charset=UTF-8"
        return h

    def _extract_created_ids(self, raw: str) -> None:
        """Из ответа create.account достаём IG pk (created_user) и family uid."""
        if not raw:
            return
        # created_user pk (== ds_user_id) — плоское или экранированное поле.
        for pat in (r'"created_user"\s*:\s*\{[^}]*?"pk"\s*:\s*"?(\d+)"?',
                    r'\\"pk\\"\s*:\s*\\?"?(\d{6,})\\?"'):
            m = re.search(pat, raw)
            if m:
                self.created_user_id = m.group(1)
                break
        if not self.created_user_id and self.ds_user_id:
            self.created_user_id = self.ds_user_id
        # family uid — в bloks-действии вида (f6m 6 "uid" "17841446599935027").
        m = re.search(r'"uid"\s+"(\d{6,})"', raw) or re.search(r'\\"uid\\"\s*:\s*\\?"?(\d{6,})', raw)
        if m:
            self.created_fb_uid = m.group(1)

    def _extract_experience_id(self, raw: str) -> None:
        """Достаёт experience_id онбординга (UUID) из ответа profile/transition."""
        if not raw or self.experience_id:
            return
        m = re.search(r'experience_id[\\":\s]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})', raw)
        if not m:
            # запасной вариант: любой UUID рядом с "APPROVED"/"new_users_meta_flow"
            m = re.search(r'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})', raw)
        if m:
            self.experience_id = m.group(1)

    def _nux_profile_skip(self) -> None:
        """Шаг 11: com.bloks.www.bloks.caa.registration.profile.async — пропуск
        фото профиля. Это действие двигает флоу с экрана profilephoto дальше
        и фактически завершает создание профиля (profile_photo=null)."""
        bday_str = f"{self.birthday_day:02d}-{self.birthday_month:02d}-{self.birthday_year}"
        today = datetime.date.today()
        age = today.year - self.birthday_year - (
            (today.month, today.day) < (self.birthday_month, self.birthday_day))
        reg_info_dict = json.loads(self._reg_info(
            contactpoint=self.email,
            confirmation_code=self.confirmation_code,
            birthday=bday_str,
            username=self.username,
            encrypted_password=self.encrypted_password_cached,
            first_name=getattr(self, "first_name", None),
            last_name=getattr(self, "last_name", None),
            full_name=self.full_name,
            should_save_password=True,
        ))
        reg_info_dict["age_range"] = "o18" if age >= 18 else "u18"
        reg_info_dict["family_device_id"] = self.family_device_id
        reg_info_dict["profile_photo"] = None
        reg_info = json.dumps(reg_info_dict, separators=(",", ":"))

        server_params = {
            "is_from_logged_out": 0,
            "offline_experiment_group": "caa_launch_ig",
            "family_device_id": self.family_device_id,
            "layered_homepage_experiment_group": "default_control",
            "INTERNAL__latency_qpl_instance_id": self.qpl_instance_id_base,
            "login_surface": "unknown",
            "flow_info": self._flow_info(),
            "reg_info": reg_info,
        }
        nav = self._nux_nav_chain(include_transition=False)
        h = self._graphql_authed_headers(
            "BKCdsScreenViewController:com.bloks.www.bloks.caa.reg.profilephoto", nav)
        resp = post_graphql_bloks(
            self.session,
            "com.bloks.www.bloks.caa.registration.profile.async",
            server_params=server_params,
            client_input_params={},
            headers=h,
        )
        raw = resp.get("raw") or ""
        print(f"[NUX] profile.async (skip photo) -> HTTP {resp['status_code']}")
        if resp["status_code"] != 200:
            print(f"       body: {raw[:400]}")
        self._capture_auth_headers(resp)
        self._extract_experience_id(raw)
        if not self.created_fb_uid:
            self._extract_created_ids(raw)

    def _nux_reg_transition(self) -> None:
        """Шаг 12: com.bloks.www.bloks.caa.reg.transition.async — переход ntf.
        reg_info здесь урезанный, с проставленным user_id созданного аккаунта."""
        reg_info = json.dumps({
            "first_name": getattr(self, "first_name", None),
            "last_name": getattr(self, "last_name", None),
            "full_name": self.full_name,
            "contactpoint": None,
            "contactpoint_type": "email",
            "username": self.username,
            "family_device_id": self.family_device_id,
            "user_id": self.created_fb_uid or self.created_user_id or None,
        }, separators=(",", ":"))
        server_params = {
            "is_from_logged_out": 0,
            "offline_experiment_group": None,
            "family_device_id": self.family_device_id,
            "layered_homepage_experiment_group": None,
            "INTERNAL__latency_qpl_instance_id": self.qpl_instance_id_base,
            "login_surface": "unknown",
            "flow_info": self._flow_info(),
            "reg_info": reg_info,
        }
        nav = self._nux_nav_chain(include_transition=True)
        h = self._graphql_authed_headers(
            "com.bloks.www.bloks.caa.reg.transition:com.bloks.www.bloks.caa.reg.transition", nav)
        resp = post_graphql_bloks(
            self.session,
            "com.bloks.www.bloks.caa.reg.transition.async",
            server_params=server_params,
            client_input_params={},
            headers=h,
        )
        raw = resp.get("raw") or ""
        print(f"[NUX] reg.transition.async -> HTTP {resp['status_code']}")
        if resp["status_code"] != 200:
            print(f"       body: {raw[:400]}")
        self._capture_auth_headers(resp)
        self._extract_experience_id(raw)

    def _nux_privacy_consent(self) -> None:
        """Шаг 13: privacy-consent онбординга new_users_meta_flow.

        В дампах реального клиента этот эндпоинт вызывается ДВАЖДЫ:
          1) PROMPT — params только {flow_name, source} (БЕЗ experience_id).
             Ответ на него содержит experience_id (UUID).
          2) ACTION — те же params + experience_id из шага 1.
             Ответ содержит "APPROVED" <experience_id> — это и есть финальное
             подтверждение, что онбординг закрыт (аккаунт не partially_created).
        """
        nav = self._nux_nav_chain(include_transition=True)
        endpoint = ("com.bloks.www.bloks.caa.reg.transition:"
                    "com.bloks.www.bloks.caa.reg.transition")

        # --- фаза 1: PROMPT (без experience_id) -> достаём experience_id ---
        prompt_params = {
            "flow_name": "new_users_meta_flow",
            "source": "source",
        }
        h1 = self._graphql_authed_headers(endpoint, nav)
        resp1 = post_graphql_bloks(
            self.session,
            "com.bloks.www.privacy.consent.prompt.action",
            server_params=prompt_params,
            client_input_params={},
            headers=h1,
        )
        raw1 = resp1.get("raw") or ""
        print(f"[NUX] consent PROMPT -> HTTP {resp1['status_code']}")
        if resp1["status_code"] != 200:
            print(f"       body: {raw1[:400]}")
        self._capture_auth_headers(resp1)
        # experience_id приходит именно здесь
        self._extract_experience_id(raw1)
        if not self.experience_id:
            print("[NUX] consent: experience_id не найден в ответе PROMPT — "
                  "approve пропущен")
            print(f"       body: {raw1[:400]}")
            return

        self._rand_sleep(0.5, 1.2)

        # --- фаза 2: ACTION (с experience_id) -> ждём APPROVED ---
        action_params = {
            "flow_name": "new_users_meta_flow",
            "INTERNAL__latency_qpl_marker_id": self.qpl_marker_id,
            "INTERNAL__latency_qpl_instance_id": self.qpl_instance_id_base,
            "_w_s228763": "",
            "source": "source",
            "experience_id": self.experience_id,
        }
        h2 = self._graphql_authed_headers(endpoint, nav)
        resp2 = post_graphql_bloks(
            self.session,
            "com.bloks.www.privacy.consent.prompt.action",
            server_params=action_params,
            client_input_params={},
            headers=h2,
        )
        raw2 = resp2.get("raw") or ""
        ok = "APPROVED" in raw2
        self.nux_consent_approved = ok
        print(f"[NUX] consent ACTION -> HTTP {resp2['status_code']}"
              f"{' (APPROVED)' if ok else ''}")
        if resp2["status_code"] != 200 or not ok:
            print(f"       body: {raw2[:400]}")
        self._capture_auth_headers(resp2)

    def _nux_nav_chain(self, include_transition: bool) -> str:
        """nav-chain, отражающий пройденный флоу регистрации вплоть до
        profilephoto (и transition, если include_transition)."""
        now = time.time()
        chain = (
            "BKCdsScreenViewController:com.bloks.www.caa.login.landing_screen:1:cold_start:"
            f"{now:.6f}:::{now:.6f},"
            "BKCdsScreenViewController:com.bloks.www.bloks.caa.reg.tos:9::"
            f"{now:.6f}:::{now:.6f},"
            "BKCdsScreenViewController:com.bloks.www.bloks.caa.reg.profilephoto:10::"
            f"{now:.6f}:::{now:.6f}"
        )
        if include_transition:
            chain += (
                ",com.bloks.www.bloks.caa.reg.transition:com.bloks.www.bloks.caa.reg.transition:11::"
                f"{now:.6f}:::{now:.6f}"
            )
        return chain

    def _complete_registration_nux(self) -> None:
        """Оркестрация пост-регистрационного NUX: profile-skip -> transition ->
        privacy-consent. Каждый шаг best-effort (ошибка одного не рушит остальные),
        паузы короткие — экран фото мы пропускаем."""
        if not self.bearer:
            print("[NUX] пропуск: нет bearer после create.account")
            return
        print("[NUX] завершаю онбординг (снятие partially_created)...")
        try:
            self._nux_profile_skip()
        except Exception as e:
            print(f"[NUX] profile.async ошибка: {type(e).__name__}: {e}")
        self._rand_sleep(0.6, 1.6)
        try:
            self._nux_reg_transition()
        except Exception as e:
            print(f"[NUX] reg.transition.async ошибка: {type(e).__name__}: {e}")
        self._rand_sleep(0.6, 1.6)
        try:
            self._nux_privacy_consent()
        except Exception as e:
            print(f"[NUX] privacy.consent ошибка: {type(e).__name__}: {e}")

        # ИТОГ: как в реальном клиенте, финальное подтверждение закрытия
        # онбординга — это ответ "APPROVED" на consent ACTION. Это первичный
        # источник истины (current_user отвечает 200 даже на partially_created).
        if self.nux_consent_approved:
            print("[NUX] ГОТОВО: consent APPROVED — онбординг закрыт, аккаунт "
                  "полноценный (не partially_created)")
        else:
            print("[NUX] ВНИМАНИЕ: APPROVED не получен — аккаунт может остаться "
                  "partially_created. С��отри 'body:' в логах consent выше.")

        # Доп. (необязательная) проверка через current_user — только как
        # вторичный сигнал, НЕ определяющий partially_created сам по себе.
        self._rand_sleep(0.6, 1.6)
        try:
            self._verify_account_full()
        except Exception as e:
            print(f"[VERIFY] ошибка проверки: {type(e).__name__}: {e}")

    def _verify_account_full(self) -> bool:
        """Вторичная проверка: авторизованный /api/v1/accounts/current_user/.
        ВНИМАНИЕ: current_user отвечает 200 и на partially_created-аккаунтах,
        поэтому это лишь дополнительный сигнал (bearer рабочий, сессия жива),
        а НЕ определяющий признак завершённости онбординга. Главный критерий —
        APPROVED из consent ACTION (см. self.nux_consent_approved)."""
        if not self.bearer:
            return False
        h = dict(self._headers())
        h["authorization"] = self.bearer
        if self.ds_user_id:
            h["ig-intended-user-id"] = self.ds_user_id
            h["ig-u-ds-user-id"] = self.ds_user_id
        if self.rur:
            h["ig-u-rur"] = self.rur
        h["x-ig-www-claim"] = self.www_claim or "0"
        try:
            r = self.session.get(
                f"{INSTAGRAM_HOST}/api/v1/accounts/current_user/?edit=true",
                headers=h, timeout=20,
            )
        except Exception as e:
            print(f"[VERIFY] запрос current_user не удался: {type(e).__name__}: {e}")
            return False
        body = r.text or ""
        low = body.lower()
        is_partial = ("partially_created" in low) or ('"status":"fail"' in low) \
            or ("login_required" in low)
        has_user = ('"username"' in low) or ('"pk"' in low) or ('"pk_id"' in low)
        ok = (r.status_code == 200) and has_user and not is_partial
        if ok:
            print(f"[VERIFY] current_user HTTP 200, сессия жива, username виден "
                  f"(вторичный сигнал)")
        else:
            print(f"[VERIFY] current_user слабый сигнал: "
                  f"HTTP {r.status_code}, has_user={has_user}, partial={is_partial}")
            print(f"         body: {body[:400]}")
        return ok

    # ----- шаги регистрации ------------------------------------------------

    def step1_aymh_create_account_button(self) -> Dict[str, Any]:
        """1. Нажатие "Create new account" на login_home."""
        print("\n[1/10] aymh_create_account_button.async")

        server_params = self._common_server_params({
            "is_from_lid_welcome_screen": 0,
            "should_show_wa_nta_bottom_sheet": 0,
            "event_step": "landing",
            "is_eligible_for_igds_sac_reg_flow": 0,
            "should_expand_layered_bottom_sheet": 0,
            "reg_flow_source": "login_home_native_integration_point",
            "is_caa_perf_enabled": 1,
            "entrypoint": "login_home_async",
        })
        client_input_params = {
            "zero_balance_state": "",
            "network_bssid": None,
            "cloud_trust_token": self.cloud_trust_token,
            "should_show_nested_nta_bottom_sheet": 0,
            "aac": self._aac_string(),
            "username_input": "",
            "accounts_list": [],
            "lois_settings": {"lois_token": ""},
        }

        return post_graphql_bloks(
            self.session,
            "com.bloks.www.bloks.caa.reg.aymh_create_account_button.async",
            server_params,
            client_input_params,
            self._headers(),
            client_doc_id=CLIENT_DOC_ID_DEFAULT,
        )

    def step2_expose_ntm_experiment(self) -> Dict[str, Any]:
        """2. Async logging NTM эксперимента."""
        print("[2/10] expose_ntm_experiment.async")

        params = {
            "params": json.dumps({
                "server_params": self._common_server_params(),
                "client_input_params": {
                    "aac": self._aac_string(),
                    "network_bssid": None,
                    "lois_settings": {"lois_token": ""},
                },
            }, separators=(",", ":")),
            "bloks_versioning_id": self.bloks_versioning_id,
            "bk_client_context": json.dumps(BK_CONTEXT, separators=(",", ":")),
        }

        return post_async_action(
            self.session,
            "com.bloks.www.bloks.caa.reg.async.expose_ntm_experiment.async",
            params,
            self._headers(),
        )

    def step3_contactpoint_email(self) -> Dict[str, Any]:
        """3. contactpoint_email — максимально близко к реальному iOS"""
        print(f"[3/10] contactpoint_email - {self.email}")

        server_params = self._common_server_params({
            "aac": self._aac_string() if hasattr(self, '_aac_string') else "",
            "flow_info": self._flow_info(),
            "reg_info": self._reg_info(contactpoint=self.email),
            "current_step": 0,
            "INTERNAL_INFRA_screen_id": str(uuid.uuid4()),
            "root_screen_id": "CAA_REG_CONTACT_POINT_EMAIL",
            "cp_funnel": 0,
            "cp_source": 0,
            "prefetch_on_field": 1,
            "is_from_logged_out": 1,
            "offline_experiment_group": "caa_iteration_v3_perf_ig_4",
            "layered_homepage_experiment_group": "igios_layered_landing_screen_experiment_ld_with_xmds_v2",
        })

        client_input_params = self._common_client_params({
            "email": self.email,
            "email_prefilled": 0,
            "confirmed_cp_and_code": {},
            "is_from_device_emails": 0,
            "prefetch_version": 11,
            "si_device_param_network_info": self._caa_network_info() if hasattr(self, '_caa_network_info') else {},
            "block_store_machine_id": "",
            "fb_ig_device_id": [],
            "accounts_list": [],
            "lois_settings": {"lois_token": ""},
            "zero_balance_state": "",
            "cloud_trust_token": getattr(self, "cloud_trust_token", ""),
        })

        response = post_graphql_bloks(
            self.session,
            "com.bloks.www.bloks.caa.reg.contactpoint_email",
            server_params,
            client_input_params,
            self._headers(),
            client_doc_id=CLIENT_DOC_ID_CONTACTPOINT,  # если есть
        )

        # Критично — обновляем reg_context
        if isinstance(response, dict):
            self.reg_context = response.get("reg_context") or self.reg_context
            print(f"[DEBUG] После step3 reg_context: {self.reg_context[:100] if self.reg_context else 'NONE'}...")

        return response

    def step4_send_confirmation_email(self) -> Dict[str, Any]:
        """4. Отправка кода подтверждения на email."""
        print("[4/10] send_confirmation_email.async")

        params = {
            "params": json.dumps({
                "server_params": self._common_server_params({
                    "flow_info": self._flow_info(),
                    "reg_info": self._reg_info(contactpoint=self.email),
                    "reg_context": self.reg_context or "",
                    "current_step": 0,
                }),
                "client_input_params": {
                    "aac": self._aac_string(),
                    "machine_id": self.machine_id,
                    "network_bssid": None,
                    "cloud_trust_token": self.cloud_trust_token,
                    "lois_settings": {"lois_token": ""},
                    "contactpoint": self.email,
                },
            }, separators=(",", ":")),
            "bloks_versioning_id": self.bloks_versioning_id,
            "bk_client_context": json.dumps(BK_CONTEXT, separators=(",", ":")),
        }
        response = post_async_action(
            self.session,
            "com.bloks.www.bloks.caa.reg.send_confirmation_email.async",
            params,
            self._headers(),
        )
        self.reg_context = response.get("reg_context") or self.reg_context
        return response

    def step3_contactpoint_phone(self) -> Dict[str, Any]:
        """3. contactpoint_phone — SMS верификация (вместо contactpoint_email)"""
        print(f"[3/10] contactpoint_phone - {self.phone}")

        server_params = self._common_server_params({
            "aac": self._aac_string() if hasattr(self, '_aac_string') else "",
            "flow_info": self._flow_info(),
            "reg_info": self._reg_info(contactpoint=self.phone_e164, contactpoint_type="phone"),
            "current_step": 0,
            "INTERNAL_INFRA_screen_id": str(uuid.uuid4()),
            "root_screen_id": "CAA_REG_CONTACT_POINT_PHONE",
            "cp_funnel": 0,
            "cp_source": 0,
            "prefetch_on_field": 1,
            "is_from_logged_out": 1,
            "offline_experiment_group": "caa_iteration_v3_perf_ig_4",
            "layered_homepage_experiment_group": "igios_layered_landing_screen_experiment_ld_with_xmds_v2",
        })

        client_input_params = self._common_client_params({
            "phone": self.phone_e164,
            "phone_prefilled": 0,
            "confirmed_cp_and_code": {},
            "is_from_device_contacts": 0,
            "prefetch_version": 11,
            "si_device_param_network_info": self._caa_network_info() if hasattr(self, '_caa_network_info') else {},
            "block_store_machine_id": "",
            "fb_ig_device_id": [],
            "accounts_list": [],
            "lois_settings": {"lois_token": ""},
            "zero_balance_state": "",
            "cloud_trust_token": getattr(self, "cloud_trust_token", ""),
        })

        response = post_graphql_bloks(
            self.session,
            "com.bloks.www.bloks.caa.reg.contactpoint_phone",
            server_params,
            client_input_params,
            self._headers(),
            client_doc_id=CLIENT_DOC_ID_CONTACTPOINT,
        )

        if isinstance(response, dict):
            self.reg_context = response.get("reg_context") or self.reg_context
            print(
                f"[DEBUG] После step3 (phone) reg_context: {self.reg_context[:100] if self.reg_context else 'NONE'}...")

        return response

    def step3_2_contactpoint_phone_async(self) -> Dict[str, Any]:
        """3.2 contactpoint_phone.async — ФАКТИЧЕСКАЯ отправка (submit) номера.

        ПОЧЕМУ SMS НЕ ПРИХОДИЛ БЕЗ ЭТОГО ШАГА:
        step3 (contactpoint_phone) — это лишь ЗАГРУЗКА экрана ввода номера.
        Сам номер уходит на сервер отдельным запросом
        com.bloks.www.bloks.caa.reg.async.contactpoint_phone.async (dump #2).
        Именно он регистрирует contactpoint на стороне сервера. Без него
        confirm_sms_dispatch/send_confirmation выполняются, но серверу нечего
        подтверждать — номер не сабмичен, поэтому SMS не отправляется.

        ���люч��вые поля из дампа:
          - client_input_params.phone = НАЦИОНАЛЬНЫЙ номер как ЧИСЛО (5402599731)
          - client_input_params.country_code = код страны как ЧИСЛО (1)
          - reg_info.contactpoint здесь ещё None (номер идёт через client_input_params)
          - client_doc_id = CLIENT_DOC_ID_DEFAULT
        """
        print(f"[3.2/10] contactpoint_phone.async (submit) - {self.phone_e164}")

        # server_params строим ЯВНО (не через _common_server_params), чтобы точно
        # повторить набор ключей из дампа #2 и не добавлять лишних полей
        # (login_entry_point / cloud_trust_token в server_params), из-за которых
        # сервер отвечал field_exception.
        server_params = {
            "is_from_logged_out": 0,
            "access_flow_version": "pre_mt_behavior",
            "offline_experiment_group": "caa_launch_ig",
            "family_device_id": self.family_device_id,
            "layered_homepage_experiment_group": "default_control",
            "INTERNAL__latency_qpl_instance_id": self.qpl_instance_id_base,
            "cp_source": 0,
            "event_request_id": str(uuid.uuid4()),
            "login_surface": "unknown",
            "flow_info": self._flow_info(),
            "reg_info": self._reg_info(),  # contactpoint здесь None, как в дампе
            "waterfall_id": self.waterfall_id,
            "text_input_id": self.text_input_id or self.qpl_instance_id_base,
            "is_platform_login": 0,
            "current_step": 0,
            "device_id": self.device_id,
            "is_from_logged_in_switcher": 0,
            "INTERNAL__latency_qpl_marker_id": self.qpl_marker_id,
            "cp_funnel": 0,
        }

        # client_input_params — ровно 27 ключей из дампа #2 (важно: phone и
        # country_code — целые чи��ла; ��анее не хватало family_device_id и build_type).
        client_input_params = {
            "headers_infra_flow_id": "",
            "family_device_id": self.family_device_id,
            "block_store_machine_id": "",
            "was_headers_prefill_available": 0,
            "lois_settings": {"lois_token": ""},
            "zero_balance_state": "",
            "country_code": self.phone_country_code,
            "was_headers_prefill_used": 0,
            "cloud_trust_token": self.cloud_trust_token,
            "device_id": self.device_id,
            "switch_cp_first_time_loading": 1,
            "confirmed_cp_and_code": {},
            "msg_previous_cp": "",
            "login_upsell_phone_list": [],
            "seen_login_upsell": 0,
            "phone": int(self.phone_national),
            "build_type": "",
            "prefill_attempted_silent_auth": 0,
            "has_rejected_rel": 0,
            "encrypted_msisdn": "",
            "fb_ig_device_id": [],
            "device_network_info": None,
            "switch_cp_have_seen_suma": 0,
            "aac": self._aac_string(),
            "accounts_list": [],
            "whatsapp_installed_on_client": 0,
            "network_bssid": None,
        }

        response = post_graphql_bloks(
            self.session,
            "com.bloks.www.bloks.caa.reg.async.contactpoint_phone.async",
            server_params,
            client_input_params,
            self._headers(),
            client_doc_id=CLIENT_DOC_ID_DEFAULT,
        )

        if isinstance(response, dict):
            self.reg_context = response.get("reg_context") or self.reg_context
            print(
                f"[DEBUG] После step3.2 (phone submit) reg_context: "
                f"{self.reg_context[:100] if self.reg_context else 'NONE'}...")

        return response

    def step3_5_confirm_sms_dispatch(self) -> Dict[str, Any]:
        """3.5 confirm_sms_dispatch — экран/боттом-шит подтверждения отправки SMS.

        ПОЧЕМУ ЭТОТ ШАГ ОБЯЗАТЕЛЕН:
        В реальном iOS-флоу между contactpoint_phone (step3) и
        send_confirmation (step4) клиент запрашивает экран
        com.bloks.www.bloks.caa.reg.confirm_sms_dispatch. Именно он сообщает
        серверу, что пользователь от��рыл боттом-шит подтверждения номера
        (is_bottomsheet=1) и переводит серверный state в
        CAA_REG_CONFIRM_SMS_SENT:should_trigger_sms. Без него send_confirmation
        уходит вне очереди и step4 возвращает неверный результат.

        Это bloks_app-запрос через graphql (как contactpoint_phone), тот же
        client_doc_id = CLIENT_DOC_ID_CONTACTPOINT.
        """
        print(f"[3.5/10] confirm_sms_dispatch - {self.phone}")

        server_params = self._common_server_params({
            "aac": self._aac_string(),
            "flow_info": self._flow_info(),
            "reg_info": self._reg_info(contactpoint=self.phone_e164, contactpoint_type="phone"),
            "reg_context": self.reg_context or "",
            "current_step": 0,
            "INTERNAL_INFRA_screen_id": str(uuid.uuid4()),
            "use_content_variant": 1,
            "is_bottomsheet": 1,
            "layered_homepage_experiment_group": "default_control",
        })

        # В дампе client_input_params содержит только lois_settings.
        client_input_params = {
            "lois_settings": {"lois_token": ""},
        }

        response = post_graphql_bloks(
            self.session,
            "com.bloks.www.bloks.caa.reg.confirm_sms_dispatch",
            server_params,
            client_input_params,
            self._headers(),
            client_doc_id=CLIENT_DOC_ID_CONTACTPOINT,
        )

        if isinstance(response, dict):
            self.reg_context = response.get("reg_context") or self.reg_context
            print(
                f"[DEBUG] После step3.5 (confirm_sms_dispatch) reg_context: "
                f"{self.reg_context[:100] if self.reg_context else 'NONE'}...")

        return response

    def step4_send_confirmation_sms(self) -> Dict[str, Any]:
        """4. Отправка SMS-кода подтверждения (send_confirmation.async).

        ПОЧЕМУ РАНЬШЕ БЫЛ HTTP 404 / field_exception:
        В реа��ьно�� iOS-дампе этот запрос идёт как
        IGBloksAppRootQuery-...send_confirmation.async, то есть через
        /graphql_www (post_graphql_bloks), КАК step3 и step5 — а не через
        /api/v1/bloks/async_action/ (post_async_action). Старый код бил не в
        тот endpoint и слал client_input_params с полями contactpoint/machine_id,
        которых настоящий клиент здесь НЕ отправляет. Сервер не находил нужные
        поля и возвращал field_exception ("Payload returned is null").

        Ниже структура точно повторяет дамп send_confirmation:
          - server_params: phone (локальный номер), event_request_id, flow_info,
            reg_info, accounts_list, login_surface="unknown", current_step=0;
          - client_input_params: build_type, device_id, family_device_id,
            qe_device_id, aac, network_bssid, cloud_trust_token, lois_settings
            (без contactpoint и без machine_id).
        """
        print("[4/10] send_confirmation_sms.async")

        server_params = self._common_server_params({
            # В дампе phone здесь — ЧИСЛО (5402599731), а не строка.
            "phone": int(self.phone_national),
            "event_request_id": str(uuid.uuid4()),
            "login_surface": "unknown",
            "accounts_list": [],
            "flow_info": self._flow_info(),
            "reg_info": self._reg_info(contactpoint=self.phone_e164, contactpoint_type="phone"),
            "current_step": 0,
            "layered_homepage_experiment_group": "default_control",
        })

        client_input_params = {
            "build_type": "",
            "network_bssid": None,
            "device_id": self.device_id,
            "cloud_trust_token": self.cloud_trust_token,
            "aac": self._aac_string(),
            "family_device_id": None,
            "qe_device_id": "",
            "lois_settings": {"lois_token": ""},
        }

        response = post_graphql_bloks(
            self.session,
            "com.bloks.www.bloks.caa.reg.send_confirmation.async",
            server_params,
            client_input_params,
            self._headers(),
            client_doc_id=CLIENT_DOC_ID_DEFAULT,
        )
        self.reg_context = response.get("reg_context") or self.reg_context
        return response
    def step5_confirmation_email(self, code: str) -> Dict[str, Any]:
        """5. Подтверждение кода из EMAIL (Outlook / AnyMessage / iCloud).

        Отдельный метод для email-контактпоинта. Здесь contactpoint = email,
        код кладётся и в reg_info.confirmation_code, и в client_input_params.code
        как СТРОКА, fb_ig_device_id = None. Это исходное рабочее поведение для
        email — его нельзя смешивать с SMS-вариантом (contactpoint=phone,
        code=int, confirmation_medium=sms), иначе сервер отвечает field_exception.
        """
        print(f"[5/10] confirmation.async (email) - код {code}")

        server_params = self._common_server_params({
            "event_request_id": str(uuid.uuid4()),
            "sms_retriever_started_prior_step": 0,
            "flow_info": self._flow_info(),
            "text_input_id": self.text_input_id or int(time.time() * 1000),
            "wa_timer_id": "wa_retriever",
            "reg_context": self.reg_context or "",
            "reg_info": self._reg_info(contactpoint=self.email, confirmation_code=code),
            # current_step числом (не строкой "confirmation") — см. коммент ниже.
            "current_step": 3,
        })
        client_input_params = {
            "confirmed_cp_and_code": {},
            "fb_ig_device_id": None,
            "network_bssid": None,
            "cloud_trust_token": self.cloud_trust_token,
            "code": code,
            "family_device_id": None,
            "device_id": self.device_id,
            "block_store_machine_id": "",
            "aac": self._aac_string(),
            "lois_settings": {"lois_token": ""},
        }
        response = post_graphql_bloks(
            self.session,
            "com.bloks.www.bloks.caa.reg.confirmation.async",
            server_params,
            client_input_params,
            self._headers(),
        )
        new_code = extract_confirmation_code(response["raw"])
        print(new_code)
        self.reg_context = response.get("reg_context") or self.reg_context
        self.confirmation_code = new_code
        return response

    def step5_confirmation(self, code: str) -> Dict[str, Any]:
        """5. Подтверждение кода из SMS (Textverified)."""
        print(f"[5/10] confirmation.async (sms) - код {code}")

        server_params = self._common_server_params({
            "event_request_id": str(uuid.uuid4()),
            "sms_retriever_started_prior_step": 0,
            "flow_info": self._flow_info(),
            "text_input_id": self.text_input_id or int(time.time() * 1000),
            "wa_timer_id": "wa_retriever",
            "reg_context": self.reg_context or "",
            # SMS-подтверждение: contactpoint = телефон в E.164, тип "phone".
            # Раньше сюда шёл self.email (обычно None) — сервер не мог сопоставить
            # контактную точку с отправленным SMS и отвечал field_exception.
            # confirmation_code в reg_info оставляем None (сам код идёт в
            # client_input_params.code), как в дампе #5.
            "reg_info": self._reg_info(contactpoint=self.phone_e164, contactpoint_type="phone"),
            # В дампе присутствует confirmation_medium: "sms".
            "confirmation_medium": "sms",
            # ВАЖНО: current_step должен быть ЧИСЛОМ а не строкой "confirmation".
            # Все остальные шаги (step3=0, step6=4, step7=6, step8=7) используют
            # числа. Если step5 отправляет строку - сервер не распознаёт его как
            # confirmation step, игнорирует код, и уводит на ветку email OAuth
            # token (видно как CAA_REG_CONTACTPOINT_EMAIL_OAUTH_TOKEN в ответе).
            "current_step": 3,
        })
        client_input_params = {
            "confirmed_cp_and_code": {},
            # В дампе fb_ig_device_id — пустой список, а не None.
            "fb_ig_device_id": [],
            "network_bssid": None,
            "cloud_trust_token": self.cloud_trust_token,
            # КРИТИЧНО: code должен быть ЧИСЛОМ (в дампе 540963), а не строкой
            # "248015". Строковый код сервер отвергает как невалидный.
            "code": int(re.sub(r"\D", "", str(code))),
            "family_device_id": None,
            "device_id": self.device_id,
            "block_store_machine_id": "",
            "aac": self._aac_string(),
            "lois_settings": {"lois_token": ""},
        }
        response = post_graphql_bloks(
            self.session,
            "com.bloks.www.bloks.caa.reg.confirmation.async",
            server_params,
            client_input_params,
            self._headers(),
        )
        new_code = extract_confirmation_code(response["raw"])
        print(new_code)
        self.reg_context = response.get("reg_context") or self.reg_context
        self.confirmation_code = new_code
        return response

    def _fetch_password_key(self) -> None:
        """Получить ключ шифрования через launcher/mobileconfig/"""
        import time
        url = f"{INSTAGRAM_HOST}/api/v1/launcher/mobileconfig/"

        ts = str(int(time.time()))
        params_obj = {
            "device_id": self.device_id,
            "ts": ts,
            "client_context": "[\"opt,value_hash\"]",
            "bool_opt_policy": "0",
            "unit_type": "1",
            "fetch_type": "ASYNC_FULL",
            "query_hash": "8ace8ac76cd0763f17ad9f3672ded0e5d9709b4db7237ea5a7bfc8c20a7f45bb",
            "api_version": "3",
            "use_case": "STANDARD",
            "fetch_mode": "CONFIG_SYNC_ONLY",
        }

        body = "signed_body=SIGNATURE." + quote(
            json.dumps(params_obj, separators=(",", ":")), safe=""
        )

        headers = dict(self._headers())
        headers["x-fb-friendly-name"] = "api"
        headers["x-bloks-is-panorama-enabled"] = "true"
        headers["x-bloks-is-prism-enabled"] = "false"
        headers["x-bloks-prism-font-enabled"] = "false"
        headers["x-bloks-prism-colors-enabled"] = "false"
        headers["x-ig-connection-speed"] = "-1kbps"
        headers["x-ig-abr-connection-speed-kbps"] = "0"
        headers["content-length"] = str(len(body))

        r = self.session.post(url, data=body, headers=headers, timeout=15)

        kid = r.headers.get("ig-set-password-encryption-key-id", "")
        pub = r.headers.get("ig-set-password-encryption-pub-key", "")

        print(f"[DEBUG] mobileconfig status={r.status_code}, key_id={kid}, pub_key={'OK' if pub else 'NONE'}")

        if kid:
            self.enc_key_id = int(kid)
        if pub:
            self.enc_pub_key_b64 = pub

    def encrypt_password(self) -> str:
        """Шифрование пароля в формате #PWD_INSTAGRAM:4 (как нативный iOS/Android клиент).

        Алгоритм совпадает с эталонной реализацией Instagram:
          1. RSA-PKCS1v15 шифрование случайного 32-байтного AES-ключа публичным
             ключом из заголовка ig-set-password-encryption-pub-key.
          2. AES-256-GCM шифрование пароля этим ключом, timestamp идёт как AAD.
          3. Сборка blob:
             \\x01 + key_id(1) + IV(12) + size(LE,2) + rsa_enc + tag(16) + ciphertext

        Исправления относительно старой версии, дававшей "something went wrong":
          * RSA padding = PKCS1v15, а НЕ OAEP/SHA1.
          * Случайный 12-байтный IV, который ОБЯЗАТЕЛЬНО включается в blob —
            без него сервер физически не может расшифровать AES-GCM.
          * Длина RSA-блока пишется little-endian ('<H'), а не big-endian.
        """
        import base64, os, struct, time
        from cryptography.hazmat.primitives.asymmetric import padding
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        if not self.enc_pub_key_b64:
            raise RuntimeError("Публичный ключ не получен")

        # Заголовок отдаёт base64 от PEM публичного RSA-ключа.
        pub_key_pem = base64.b64decode(self.enc_pub_key_b64)
        pub_key = serialization.load_pem_public_key(pub_key_pem)

        timestamp = int(time.time())
        aes_key = os.urandom(32)
        iv = os.urandom(12)  # случайный IV, НЕ нули

        # 1) RSA-PKCS1v15 (не OAEP).
        encrypted_aes_key = pub_key.encrypt(aes_key, padding.PKCS1v15())

        # 2) AES-256-GCM, timestamp как AAD.
        aesgcm = AESGCM(aes_key)
        aad = str(timestamp).encode("utf-8")
        ct_with_tag = aesgcm.encrypt(iv, self.ig_password.encode("utf-8"), aad)
        ciphertext = ct_with_tag[:-16]
        tag = ct_with_tag[-16:]

        # 3) blob: версия + key_id + IV + размер(LE) + rsa + tag + ciphertext.
        blob = (
            b"\x01"
            + bytes([self.enc_key_id])
            + iv
            + struct.pack("<H", len(encrypted_aes_key))
            + encrypted_aes_key
            + tag
            + ciphertext
        )

        return f"#PWD_INSTAGRAM:4:{timestamp}:{base64.b64encode(blob).decode()}"

    def step6_password(self) -> Dict[str, Any]:
        """6. Со��дание пароля — password.async (по реальному iOS дампу).

        Структура запроса воспроизводит захваченный
        IGBloksAppRootQuery-com.bloks.www.bloks.caa.reg.password.async:
        server_params строится из _common_server_params + event_request_id +
        flow_info + reg_context + reg_info (с зашифрованным паролем),
        client_doc_id = CLIENT_DOC_ID_DEFAULT (38523300859713187485104132294).
        """
        print(f"[6/10] password.async")

        # Шифруем пароль один раз и кэшируем для step10.
        encrypted_password = self.encrypt_password()
        self.encrypted_password_cached = encrypted_password

        # reg_info несёт зашифрованный пароль дальше по flow.
        reg_info = self._reg_info(
            contactpoint=self.email,
            encrypted_password=encrypted_password,
            should_save_password=True,
            confirmation_code=self.confirmation_code
        )

        # server_params как в захваченном запросе: общие параметры login_home
        # + event_request_id + flow_info + reg_context + reg_info.
        server_params = self._common_server_params({
            "event_request_id": str(uuid.uuid4()),
            "flow_info": self._flow_info(),
            "reg_context": self.reg_context or "",
            "reg_info": reg_info,
            "current_step": 4,
        })

        client_input_params = self._common_client_params({
            "encrypted_password": encrypted_password,
            "spi_action": None,
            "fb_ig_device_id": None,
            "cloud_trust_token": self.cloud_trust_token,
            "family_device_id": None,
            "device_id": self.device_id,
            "block_store_machine_id": self.machine_id or "",
        })

        response = post_graphql_bloks(
            self.session,
            "com.bloks.www.bloks.caa.reg.password.async",
            server_params,
            client_input_params,
            self._headers(),
            client_doc_id=CLIENT_DOC_ID_DEFAULT,
        )

        self._update_state_from(response, "password")
        return response

    def step7_birthday(self) -> Dict[str, Any]:
        # Ф��рмат DD-MM-YYYY через дефис!
        bday_str = f"{self.birthday_day:02d}-{self.birthday_month:02d}-{self.birthday_year}"

        bday_ts = int(
            datetime.datetime(
                self.birthday_year, self.birthday_month, self.birthday_day,
                tzinfo=datetime.timezone.utc
            ).timestamp()
        )
        print(f"[7/10] birthday.async - {bday_str}")
        print(bday_ts)
        server_params = self._common_server_params({
            "reg_context": self.reg_context or "",
            "flow_info": self._flow_info(),
            "reg_info": self._reg_info(contactpoint=self.email, birthday=bday_str),
            "current_step": 6,
        })
        client_input_params = {
            "lois_settings": {"lois_token": ""},
            "client_timezone": "America/Chicago",  # из дампа
            "is_youth_regulation_flow_complete": 0,  # int!
            "network_bssid": None,
            "birthday_or_current_date_string": bday_str,  # DD-MM-YYYY
            "os_age_range": "",  # пустая строка, не None
            "should_skip_youth_tos": 0,  # int!
            "birthday_timestamp": bday_ts,
            "aac": self._aac_string(),
            "accounts_list": [],
            "zero_balance_state": "",
        }
        response = post_graphql_bloks(
            self.session,
            "com.bloks.www.bloks.caa.reg.birthday.async",
            server_params,
            client_input_params,
            self._headers(),
        )
        self.reg_context = response.get("reg_context") or self.reg_context
        return response

    def step8_name_ig_and_soap(self) -> Dict[str, Any]:
        """
        8. name_ig_and_soap - ввод пол��ого имени (экран CAA_REG_IG_NAME_SCREEN).

        Вызывается ПОСЛЕ birthday: сервер на экране дня рож��ения отдаёт
        подготовленный шаблон именно для name_ig_and_soap, в кото��ом
        current_step=7. Поэтому current_step здесь = 7.

        Идёт на /graphql_www (IGBloksAppRootQuery), как и в реальном дампе.

        ГЛАВНОЕ ИСПРАВЛЕНИЕ (причина transition_failure_REG_IG_NAME_SOAP_TO_NEXT):
        в рабочем дампе reg_info на этом шаге несёт ВСЕ накопленные данные
        регистрации (encrypted_password, confirmation_code, birthday, age_range
        и youth-поля). Раньше step8 передавал в reg_info только contactpoint и
        full_name, поэтому пароль/код/дата уходили как null, и сервер не мог
        завершить переход с шага name → следующий шаг.
        """
        print(f"[9/10] name_ig_and_soap.async - {self.full_name}")

        # birthday в формате DD-MM-YYYY (как на шаге 7)
        bday_str = f"{self.birthday_day:02d}-{self.birthday_month:02d}-{self.birthday_year}"

        # age_range вычисляем из даты рождения: o18 (>=18) либо u18 (<18).
        import datetime
        today = datetime.date.today()
        age = today.year - self.birthday_year - (
            (today.month, today.day) < (self.birthday_month, self.birthday_day)
        )
        age_range = "o18" if age >= 18 else "u18"

        # reg_info со ВСЕМ накопленным состоянием.
        # ВНИМАНИЕ: имя в рабочем дампе уходит ТОЛЬКО в client_input_params["name"],
        # а в reg_info full_name = null — поэтому full_name сюда НЕ передаём.
        reg_info_dict = json.loads(self._reg_info(
            contactpoint=self.email,
            confirmation_code=self.confirmation_code,
            birthday=bday_str,
            encrypted_password=self.encrypted_password_cached,
        ))
        # Поля, которые в рабочем дампе непустые именно на этом шаге.
        reg_info_dict["age_range"] = age_range
        reg_info_dict["should_skip_youth_tos"] = True
        reg_info_dict["screen_visited"] = [
            "CAA_REG_CONTACT_POINT_PHONE",
            "CAA_REG_CONTACT_POINT_EMAIL",
            "CAA_REG_CONFIRMATION_SCREEN",
            "CAA_REG_PASSWORD",
            "bloks.caa.reg.birthday",
            "CAA_REG_IG_NAME_SCREEN",
        ]
        reg_info = json.dumps(reg_info_dict, separators=(",", ":"))

        server_params = self._common_server_params({
            "is_from_logged_out": 0,
            "offline_experiment_group": "caa_launch_ig",
            "reg_context": self.reg_context or "",
            "flow_info": self._flow_info(),
            "reg_info": reg_info,
            "current_step": 7,
            # login_surface в шаблоне сервера = "login_home" (НЕ "unknown").
            # _common_server_params уже ставит "login_home", поэтому не переопределяем.
        })
        client_input_params = self._common_client_params({
            "zero_balance_state": "",
            "accounts_list": [],
            "cloud_trust_token": self.cloud_trust_token,
            "name": self.full_name,
        })
        response = post_graphql_bloks(
            self.session,
            "com.bloks.www.bloks.caa.reg.name_ig_and_soap.async",
            server_params,
            client_input_params,
            self._headers(),
        )
        self.reg_context = response.get("reg_context") or self.reg_context
        return response
    # ------------------------------------------------------------------
    # Шаги 9-10 - в дампах их нет. Структура построена по паттерну шагов
    # 2, 4, 8 (тоже async_action с тем же конвертом server_params +
    # client_input_params). Если что-то из этого не сработает на боевом
    # сер��ере - первым делом сними��е свежий дамп ИМЕННО этих 2 запросов
    # и подставьте недостающие поля в client_input_params.
    # ------------------------------------------------------------------
    def step9_username(self) -> Dict[str, Any]:
        """
        9. username.async (экран CAA_REG_USERNAME).

        ��ОРЯДОК В ТЕКУЩЕМ CAA FLOW (см. run()):
            birthday(step7) -> name_ig_and_soap(step8) -> username(step9) -> create(step10)
        То есть username идёт ПОСЛЕ name. current_step=8 (на единицу больше,
        чем у name, где current_step=7).

        ПУБЛИЧНЫЕ ИСТОЧНИ��И (instagrapi и др.) + структура рабочего дампа name:
        этот шаг — обычный CAA-reg-перех��д, и его server_params/reg_info должны
        быть устроены так же, как у name_ig_and_soap, а НЕ содержать выдуманных
        полей.

        ГЛАВНОЕ ИСПРАВЛЕНИЕ (��от же класс бага, что ломал name):
        раньше reg_info на этом шаге нёс только contactpoint + username, поэтому
        encrypted_password / confirmation_code / birthday / age_range / имя
        уходили как null, и сервер не мог завершить переход username -> next.
        Теперь reg_info несёт ВСЁ накопленное состояние.

        Также убраны несуществующие в реальном CAA-reg server_params поля
        (text_input_id, suggestions_container_id, screen_id, input_id, action,
        post_tos) и приведён offline_experiment_group к значению, которое сервер
        реально использует в этом flow ("caa_launch_ig").
        """
        print(f"[8/10] username.async - {self.username}")

        # birthday в формате DD-MM-YYYY (��ак на шагах birthday/name)
        bday_str = f"{self.birthday_day:02d}-{self.birthday_month:02d}-{self.birthday_year}"

        # age_range вычисляем из даты рождения: o18 (>=18) либо u18 (<18).
        import datetime
        today = datetime.date.today()
        age = today.year - self.birthday_year - (
                (today.month, today.day) < (self.birthday_month, self.birthday_day)
        )
        age_range = "o18" if age >= 18 else "u18"

        # reg_info со ВСЕМ накопленным состоянием.
        # На этом шаге name уже отправлен, поэтому имя тоже передаём
        # (так же, как это делает финальный step10_create_account).
        reg_info_dict = json.loads(self._reg_info(
            contactpoint=self.email,
            confirmation_code=self.confirmation_code,
            birthday=bday_str,
            encrypted_password=self.encrypted_password_cached,
            username=self.username,
            first_name=self.first_name,
            last_name=self.last_name,
            full_name=self.full_name or f"{self.first_name} {self.last_name}",
        ))
        reg_info_dict["age_range"] = age_range
        reg_info_dict["should_skip_youth_tos"] = True
        # screen_visited на момент username: контакт -> код -> пароль ->
        # birthday -> name -> username.
        reg_info_dict["screen_visited"] = [
            "CAA_REG_CONTACT_POINT_PHONE",
            "CAA_REG_CONTACT_POINT_EMAIL",
            "CAA_REG_CONFIRMATION_SCREEN",
            "CAA_REG_PASSWORD",
            "bloks.caa.reg.birthday",
            "CAA_REG_IG_NAME_SCREEN",
            "CAA_REG_USERNAME",
        ]
        reg_info = json.dumps(reg_info_dict, separators=(",", ":"))

        server_params = self._common_server_params({
            "is_from_logged_out": 0,
            "offline_experiment_group": "caa_launch_ig",
            "reg_context": self.reg_context or "",
            "flow_info": self._flow_info(),
            "reg_info": reg_info,
            "current_step": 8,
            "action": 1,
            "post_tos": 0,
            "text_input_id": random.randint(100000000000000, 999999999999999),
            "suggestions_container_id": random.randint(100000000000000, 999999999999999),
            "screen_id": random.randint(100000000000000, 999999999999999),
            "input_id": random.randint(100000000000000, 999999999999999),
            # login_surface уже выставлен в _common_server_params ("login_home").
        })

        client_input_params = self._common_client_params({
            "zero_balance_state": "",
            "accounts_list": [],
            "cloud_trust_token": self.cloud_trust_token,
            # на username-экране ввод пользователя идёт в validation_text
            "validation_text": self.username,
            "username": self.username,
        })

        response = post_graphql_bloks(
            self.session,
            "com.bloks.www.bloks.caa.reg.username.async",
            server_params,
            client_input_params,
            self._headers(),
        )
        self.reg_context = response.get("reg_context") or self.reg_context
        return response

    def s(self) -> Dict[str, Any]:
        """
        9. username.async

        ВНИМАНИЕ: этот метод физически называется step9, но в run() он
        вызывается ПЕРЕД step8_name_ig_and_soap (��.к. в текущем CAA flow
        username идёт раньше name). current_step=7 потому что это 8-й
        шаг flow (нумерация с 0).
        """
        print(f"[8/10] username.async - {self.username}")

        # Обнови _common_server_params / _reg_info если нужно, чтобы они возвращали полные данные
        server_params = self._common_server_params({
            "offline_experiment_group": "caa_iteration_v3_perf_ig_4",  # важно!
            "reg_context": self.reg_context or "",
            "flow_info": self._flow_info(),  # должен быть {"flow_name": "...", "flow_type": "ntf"}
            "reg_info": self._reg_info(
                contactpoint=self.email,
                username=self.username,
            ),
            "current_step": 8,
            # Дополнительно (критично для username step):
            "action": 1,
            "post_tos": 0,
            "text_input_id": str(random.randint(10 ** 14, 10 ** 15 - 1)),  # большой random
            "suggestions_container_id": str(random.randint(10 ** 14, 10 ** 15 - 1)),
            "screen_id": str(random.randint(10 ** 14, 10 ** 15 - 1)),
            "input_id": str(random.randint(10 ** 14, 10 ** 15 - 1)),
        })

        client_input_params = self._common_client_params({
            "validation_text": self.username,
            # Можно добавить accounts_list если есть в других шагах
            "accounts_list": [],
        })

        response = post_graphql_bloks(
            self.session,
            "com.bloks.www.bloks.caa.reg.username.async",
            server_params,  # server_params первым (позиционно, как у тебя)
            client_input_params,
            self._headers(),  # ← здесь часто проблема!
        )
        self.reg_context = response.get("reg_context") or self.reg_context
        return response

    def _cancel_mail_activation(self, reason: str = "") -> None:
        """Отменяет активацию почты у провайдера (AnyMessage /email/cancel),
        чтобы вернуть баланс, когда код не пришёл. Безопасно для любого клиента:
        OutlookClient не имеет cancel_email — тогда просто ничего не делаем.
        Все ошибки гасим, т.к. это best-effort очистка, а не критичный шаг."""
        client = getattr(self, "mail_client", None)
        cancel = getattr(client, "cancel_email", None)
        if not callable(cancel):
            return
        try:
            res = cancel()
            act = getattr(client, "activation_id", None)
            print(f"[AnyMessage] активация отменена ({reason}) "
                  f"id={act}, ответ={res}")
        except Exception as e:
            print(f"[AnyMessage] не удалось отменить активацию: "
                  f"{type(e).__name__}: {e}")

    @staticmethod
    def _detect_restriction(raw: str) -> "tuple[bool, str]":
        """Определяет, попал ли только что созданный аккаунт под ограничение
        (checkpoint / UFAC / enrollment waiting room).

        ПОЧЕМУ ЭТО ВАЖНО: старая проверка была `"UFAC" in raw` — регистрозависимая
        и ловила только ВЕРХНИЙ регистр. Но реальный ответ create.account кладёт
        маркер в НИЖНЕМ регистре внутри имени контроллера:
            com.bloks.www.checkpoint.ufac.enrollment_waiting_room.controller
        Из-за этого забаненн��й (в UFAC waiting room) аккаунт не распознавался и
        попадал в таблицу, а последующие NUX-шаги отдавали 404 (нормальные
        onboarding-эндпоинты для аккаунта в checkpoint не существуют).

        Возвращает (restricted, reason).
        """
        low = (raw or "").lower()
        markers = [
            ("enrollment_waiting_room", "UFAC enrollment waiting room"),
            ("checkpoint.ufac", "UFAC checkpoint"),
            (".ufac.", "UFAC"),
            ("ufac_", "UFAC"),
            ("www.checkpoint", "checkpoint"),
            ("challenge_required", "challenge required"),
            ("account_disabled", "account disabled"),
            ("is_disabled\":true", "account disabled"),
        ]
        for needle, reason in markers:
            if needle in low:
                return True, reason
        return False, ""

    def step10_create_account(self) -> Dict[str, Any]:
        print(f"[10/10] create.account.async")
        print(f"[10/10] create.account.async - {self.username}")

        bday_str = f"{self.birthday_day:02d}-{self.birthday_month:02d}-{self.birthday_year}"

        today = datetime.date.today()
        age = today.year - self.birthday_year - (
                (today.month, today.day) < (self.birthday_month, self.birthday_day)
        )
        age_range = "o18" if age >= 18 else "u18"

        # reg_info со всем состоянием. На финальном шаге username УЖЕ задан.
        reg_info_dict = json.loads(self._reg_info(
            contactpoint=self.email,
            confirmation_code=self.confirmation_code,
            birthday=bday_str,
            username=self.username,
            encrypted_password=self.encrypted_password_cached,
            first_name=getattr(self, "first_name", None),
            last_name=getattr(self, "last_name", None),
            full_name=self.full_name or f"{getattr(self, 'first_name', '')} {getattr(self, 'last_name', '')}".strip(),
            should_save_password=True,
        ))
        reg_info_dict["age_range"] = age_range
        reg_info_dict["should_skip_youth_tos"] = True
        reg_info_dict["screen_visited"] = [
            "CAA_REG_CONTACT_POINT_PHONE",
            "CAA_REG_CONTACT_POINT_EMAIL",
            "CAA_REG_CONFIRMATION_SCREEN",
            "CAA_REG_PASSWORD",
            "bloks.caa.reg.birthday",
            "CAA_REG_IG_NAME_SCREEN",
            "CAA_REG_USERNAME",
        ]
        reg_info = json.dumps(reg_info_dict, separators=(",", ":"))

        # server_params: общие + точные п��ля create.account из aiograpi.
        server_params = self._common_server_params({
            "reg_context": self.reg_context or "",
            "flow_info": self._flow_info(),
            "reg_info": reg_info,
            "current_step": 9,
            # --- create.account-специф��чные (aiograpi) ---
            "sa_prefetch_callback_id": "",
            "should_ignore_suma_check": 0,
            "bloks_controller_source": "bk_caa_reg_tos_screen",
            "app_id": 0,
        })

        # client_input_params: общие + точный набор create.account из aiograpi.
        client_input_params = self._common_client_params({
            "passkey_eligible_device": 0,
            "ck_error": "",
            "failed_birthday_year_count": "",
            "headers_last_infra_flow_id": "",
            "ig_partially_created_account_nonce_expiry": 0,
            "should_ignore_existing_login": 0,
            "reached_from_tos_screen": 1,
            "ig_partially_created_account_nonce": "",
            "has_dismissed_suma_pre_conf": 0,
            "ck_nonce": "",
            "force_sessionless_nux_experience": 0,
            "ig_partially_created_account_user_id": 0,
            "ck_id": "",
            "no_contact_perm_email_oauth_token": "",
            "encrypted_msisdn": "",
        })

        params = {
            "params": json.dumps({
                "server_params": server_params,
                "client_input_params": client_input_params,
            }, separators=(",", ":")),
            "bloks_versioning_id": self.bloks_versioning_id,
            "bk_client_context": json.dumps(BK_CONTEXT, separators=(",", ":")),
        }

        # Специальные headers для финального шага

        response = post_async_action(
            self.session,
            "com.bloks.www.bloks.caa.reg.create.account.async",
            headers=self._headers(),
            params_obj=params
        )

        return response

    # ----- оркестрация ------------------------------------------------------

    def _capture_auth_headers(self, resp: Dict[str, Any]) -> None:
        """
        Сервер отдаёт авторизационные значения в заго��овках ответа, но НЕ
        обязательно на финальном шаге - они могут прийти на любом шаге (часто
        на confirmation / password / create_account). Поэтому ловим их на
        каждом шаге и запоминаем первое непустое значение.

        Дополнительно проверяем cookies сессии (requests складывает туда часть
        Set-Cookie вроде ds_user_id / mid).
        """
        headers = resp.get("headers") or {}
        h = {str(k).lower(): v for k, v in headers.items()}
        raw = resp.get("raw") or ""

        # x-ig-set-www-claim: заголовок -> тело ответа (экранированная строка)
        claim = h.get("x-ig-set-www-claim", "")
        if not claim or claim == "0":
            claim = extract_www_claim(raw)
        if claim and claim != "0" and not self.www_claim:
            self.www_claim = claim

        # ig-set-authorization -> "Bearer IGT:2:..." (заголовок -> тело ответа)
        bearer = h.get("ig-set-authorization", "")
        if not bearer:
            bearer = extract_bearer(raw)
        if bearer and not self.bearer:
            self.bearer = bearer

        # ds_user_id: заголовок -> cookie
        ds = h.get("ig-set-ig-u-ds-user-id", "")
        if not ds:
            try:
                ds = self.session.cookies.get("ds_user_id", "") or ""
            except Exception:
                ds = ""
        if ds:
            self.ds_user_id = str(ds)

        # x-mid
        mid = h.get("ig-set-x-mid", "")
        if mid:
            self.mid = mid

        # ig-u-rur: маршрутизационный токен региона. Реальный клиент шлёт его
        # заголовком ig-u-rur во всех авторизованных запросах после логина.
        rur = h.get("ig-set-ig-u-rur", "")
        if rur and not self.rur:
            self.rur = rur

    def _update_state_from(self, resp: Dict[str, Any], step_name: str) -> None:
        """Обновить self.reg_context из ответа сервера."""
        # Ловим авторизационные заголовки на К��ЖДОМ шаге (см. метод выше).
        self._capture_auth_headers(resp)

        if resp["status_code"] != 200:
            raise RuntimeError(
                f"[{step_name}] HTTP {resp['status_code']}: "
                f"{resp['raw'][:300]}"
            )

        raw = resp["raw"] or ""

        # Детект GraphQL-ошибки: HTTP 200, но в JSON есть ма��с��в "errors":[...]
        # Это ��ипичная ошибка ти��а "A server error field_exception occured"
        # (HTTP 200 потому что GraphQL всегда отвечает 200, а ошибки кладёт
        # в тело). Если не прерваться здесь - последующие шаги по��етят в
        # стену потому что state на сервер�� уже сломан.
        if '"errors":[' in raw:
            err_match = re.search(r'"errors":\[\s*{[^}]*?"message":"([^"]+)"', raw)
            err_msg = err_match.group(1) if err_match else "(нет message)"
            raise RuntimeError(
                f"[{step_name}] сервер вернул GraphQL error: {err_msg}\n"
                f"  raw[:400]: {raw[:400]}"
            )

        # Какой ЭКРАН сервер сейчас показыва��т (CAA_REG_<NAME>). По нему ви��но
        # совпадает ли его представление о flow с нашим. Например после step5
        # должен быть CAA_REG_PASSWORD. Если видим CAA_REG_CONTACTPOINT_EMAIL_OAUTH_TOKEN
        # - значит код не зачёлся и сервер увёл на ветку OAuth.
        screens = re.findall(r'CAA_REG_[A-Z_]+', raw)
        if screens:
            from collections import Counter
            top = Counter(screens).most_common(3)
            print(f"      экран сервера: {', '.join(f'{s}x{c}' for s, c in top)}")

        if resp["reg_context"]:
            new_ctx = resp["reg_context"]
            preview = f"{new_ctx[:30]}...{new_ctx[-10:]}"
            same = " (БЕЗ ИЗМЕНЕНИЙ)" if self.reg_context == new_ctx else ""
            self.reg_context = new_ctx
            print(f"      обновлён reg_context (длина {len(new_ctx)}): {preview}{same}")
        # else: reg_context не приходит в каждом ответе (это нормально -
        # сервер хранит state у себя и идентифицирует нас по cookie).
        # Не печатаем тут ничего, чтобы не путать.

    def run(self) -> bool:
        """Выполнить все 10 ш��гов. Возвращает True при успехе."""
        try:
            # Шаг 1: aymh button
            r = self.step1_aymh_create_account_button()
            self._update_state_from(r, "aymh")

            # Получаем ��убличный ключ для шифрования пароля (нужен на шаге 6)
            self._fetch_password_key()

            # Шаг 2: NTM
            r = self.step2_expose_ntm_experiment()
            self._update_state_from(r, "ntm")

            # ВАЖНО: step3_5_contactpoint_phone УДАЛЁН из flow.
            # Этого шага не было в исходных дампах. contactpoint_phone и
            # contactpoint_email - АЛЬТЕРНАТИВНЫЕ ветки CAA flow (либо
            # phone, либо email). Вызывая оба, мы говорим серверу "юзер
            # кликал phone", после чего сервер ждё�� phone, �� мы даём email.
            # State на сервере приходит в каше, и flow ломается на
            # confirmation/password (видно как transition_failure в логах).

            # Шаг 3: email
            # Шаг 3-4: выбор между SMS и email верификацией
            if self.sms_client:
                # SMS верификация через Textverified
                r = self.step3_contactpoint_phone()
                self._update_state_from(r, "contactpoint_phone")

                # Шаг 3.2: contactpoint_phone.async — ФАКТИЧЕСКИЙ submit номера.
                # Без него сервер не регистрирует contactpoint и SMS не уходит.
                self._rand_sleep()
                r = self.step3_2_contactpoint_phone_async()
                self._update_state_from(r, "contactpoint_phone_async")

                # Шаг 3.5: confirm_sms_dispatch — ОБЯЗАТЕЛЬНЫЙ запрос между
                # contactpoint_phone и send_confirmation. Открывает боттом-шит
                # подтверждения номера и переводит серверный state в
                # should_trigger_sms. Без него step4 возвращает неверный результат.
                self._rand_sleep()
                r = self.step3_5_confirm_sms_dispatch()
                self._update_state_from(r, "confirm_sms_dispatch")

                self._rand_sleep()
                r = self.step4_send_confirmation_sms()
                self._update_state_from(r, "send_confirmation_sms")
            else:
                # Email верификация (текущее поведение)
                r = self.step3_contactpoint_email()
                self._update_state_from(r, "contactpoint_email")

                self._rand_sleep()
                r = self.step4_send_confirmation_email()
                self._update_state_from(r, "send_confirmation_email")

            # Шаг 4.5: ожидание кода.
            # ВАЖНО: для SMS нельзя вызывать obtain_confirmation_code(self) из emailz —
            # он внутри дёргает wait_for_code(email=...), а у TextverifiedClient.wait_for_code
            # нет параметра email (сигнатура: phone, password, folder, timeout_sec, ...),
            # отсюда TypeError: unexpected keyword argument 'email'.
            # Поэтому для SMS берём код напрямую из sms_client.
            if self.sms_client:
                code = self.sms_client.wait_for_code(
                    phone=self.phone,
                    timeout_sec=self.code_wait_timeout,
                )
                if not code:
                    raise RuntimeError(
                        f"SMS-код не получен от Textverified за {self.code_wait_timeout} секунд"
                    )
            else:
                code = obtain_confirmation_code(self)
                if not code:
                    # Активацию здесь НЕ отменяем: возврат баланса делается
                    # централизованно в register_account_email (finally) на любом
                    # пути завершения, если код так и не пришёл (по code_received).
                    raise RuntimeError(f"Код не получен из почты за {self.code_wait_timeout} секунд")

            # Шаг 5: ввод кода.
            # ВАЖНО: у email и SMS РАЗНЫЕ payload'ы confirmation.async
            # (contactpoint email vs phone, code строка vs int и т.д.).
            # Смешивать их нельзя — сервер отвечает field_exception. Поэтому
            # маршрутизируем по типу контактпоинта: sms_client -> SMS-вариант,
            # иначе (Outlook/AnyMessage/iCloud) -> email-вариант.
            if self.sms_client:
                r = self.step5_confirmation(code)
            else:
                r = self.step5_confirmation_email(code)
            self._update_state_from(r, "confirmation")
            self._rand_sleep()
            # Шаг 6: пароль
            r = self.step6_password()
            self._update_state_from(r, "password")
            self._rand_sleep()
            print(f"[DEBUG] После step6 reg_context: {self.reg_context[:80] if self.reg_context else 'NONE'}")
            print(f"[DEBUG] step6 raw[:600]: {r['raw'][:30]}")

            # Шаг 7: дата рождения
            r = self.step7_birthday()
            self._update_state_from(r, "birthday")
            print(f"[DEBUG] После step7 reg_context: {self.reg_context[:80] if self.reg_context else 'NONE'}")
            print(f"[DEBUG] step7 raw[:600]: {r['raw'][:30]}")
            self._rand_sleep()
            # ВАЖНО: порядок name vs username переставлен от��осительно
            # старых дампов. В текущем CAA flow после birthday сервер
            # показывает экран USERNAME (видно из ответа step7:
            # CAA_REG_USERNAMEx13 на первом месте). Только после username
            # идёт name_ig_and_soap. Раньше отправлять name перед username
            # сервер не принимал и оставлял на э��ране NAME_IG_AND_SOAP
            # (видно из ответа step8 в логе).



            # Шаг 9 (бывший шаг 8): name_ig_and_soap ПОСЛЕ username
            r = self.step8_name_ig_and_soap()
            self._update_state_from(r, "name_ig_and_soap")
            print(f"[DEBUG] После name reg_context: {self.reg_context[:80] if self.reg_context else 'NONE'}")
            print(f"[DEBUG] name raw[:300]: {r['raw'][:80]}")

            self._rand_sleep()
            r = self.step9_username()
            self._update_state_from(r, "username")
            print(f"[DEBUG] После username reg_context: {self.reg_context[:80] if self.reg_context else 'NONE'}")
            print(f"[DEBUG] name raw[:300]: {r['raw'][:80]}")
            # Шаг 10: финальное создание аккаунта
            self._rand_sleep()
            r = self.step10_create_account()
            self._update_state_from(r, "create.account")
            # Печ��таем бо��ьше raw чтобы увидеть полный ответ финального шага
            print(f"[DEBUG] create.account raw[:2000]:\n{r['raw']}")
            if r["status_code"] != 200:
                print(f"[ОШИБКА] финальный шаг вернул HTTP {r['status_code']}")
                print(f"  ответ: {r['raw'][:300]}")
                return False

            # Аккаунт создан (HTTP 200) - готовим запись.
            # Определяем, не попал ли аккаунт в checkpoint/UFAC-ограничение.
            banned, reason = self._detect_restriction(r.get("raw") or "")
            try:
                record = build_account_record(self, r, banned=banned)
                # В xlsx пишем ТОЛЬКО рабочие аккаунты (без UFAC) с непустым bearer.
                # Причём сохранение ОТКЛАДЫВАЕМ до APPROVED (см. ниже): в таблицу
                # должны попадать лишь полностью готовые (не partially_created)
                # аккаунты. Здесь только готовим/валидируем запись.
                if banned:
                    self.xlsx_status = "banned"
                    print(f"[XLSX] аккаунт ограничен ({reason}) - в таблицу не пишем")
                elif not record.get("bearer"):
                    self.xlsx_status = "no_bearer"
                    print("[XLSX] нет bearer - в таблицу не пишем")
                else:
                    self._pending_record = record
                    print("[XLSX] запись подготовлена, отложена до APPROVED "
                          "(завершения онбординга)")
            except Exception as e:
                print(f"[XLSX] не удалось по��готовить запись: {type(e).__name__}: {e}")

            # Проверяем что в ответе есть признаки успеха
            if r["json"]:
                # ищем ds_user_id / sessionid в любом виде
                raw = r["raw"]
                if any(k in raw for k in ("ds_user_id", "sessionid", "account_created")):
                    print("\n[РЕГИСТРАЦИЯ ЗАВЕ��ШЕНА] аккаунт создан, сессия активна")
                    # извлечь useful info
                    m_uid = re.search(r'"(?:pk|user_id|ds_user_id)"\s*:\s*"?(\d+)"?', raw)
                    if m_uid:
                        print(f"  user_id: {m_uid.group(1)}")
                    cookies = dict(self.session.cookies)
                    if "sessionid" in cookies:
                        print(f"  sessionid: {cookies['sessionid'][:40]}...")

                    # Достаём id созданного аккаунта для последующих NUX-шагов.
                    self._extract_created_ids(raw)

                    # Аккаунт под ограничением (UFAC/checkpoint): NUX-эндпоинты
                    # для него не существуют и отдают 404, а в таблицу писать
                    # его нельзя. Прекращаем здесь.
                    if banned:
                        print(f"\n[РЕГИСТРАЦИЯ ОГРАНИЧЕНА] {reason} — онбординг и "
                              f"запись в xlsx пропущены")
                        return False

                    # ЗАВЕРШЕНИЕ ОНБОРДИНГА: снимаем partially_created (profile-skip
                    # -> transition -> privacy-consent). Это главный фикс против
                    # 30-минутного бана — без него аккаунт остаётся незавершённым.
                    try:
                        self._complete_registration_nux()
                    except Exception as e:
                        print(f"[NUX] прерван: {type(e).__name__}: {e}")

                    # ЗАПИСЬ В XLSX: только теперь, и только если онбординг
                    # реально закрыт (consent APPROVED). Так в таблицу попадают
                    # исключительно полностью готовые аккаунты, а не
                    # partially_created (которые банятся через ~30 минут).
                    if self._pending_record is not None:
                        if self.nux_consent_approved:
                            try:
                                save_account(self._pending_record)
                                self.xlsx_status = "added"
                                print(f"[XLSX] аккаунт сохранён в {ACCOUNTS_XLSX} "
                                      f"(APPROVED, ban={self._pending_record['ban']}, "
                                      f"ds_user_id={self._pending_record['ds_user_id']})")
                            except Exception as e:
                                print(f"[XLSX] не удалось сохранить аккаунт: "
                                      f"{type(e).__name__}: {e}")
                        else:
                            self.xlsx_status = "not_approved"
                            print("[XLSX] APPROVED не получен — аккаунт НЕ сохранён "
                                  "(не считается полностью готовым)")

                    # ПРОГРЕВ: далее эмулируем поведение реального клиента
                    # (reels_tray cold_start + timeline cold_start_fetch) тем же
                    # ус��ройством/сессией/IP.
                    try:
                        self._warmup_login_flow()
                    except Exception as e:
                        print(f"[WARMUP] прерван: {type(e).__name__}: {e}")

                    return True

                # Возможно сервер вернул error_message
                m_err = re.search(r'"error_message"\s*:\s*"([^"]+)"', raw)
                if m_err:
                    print(f"\n[ОШИБКА СОЗДАНИЯ] {m_err.group(1)}")
                    return False

            print("\n[НЕОПРЕДЕЛЁННЫЙ РЕЗУЛЬТАТ] HTTP 200, но в ответе нет ни ds_user_id, ни ошибки")
            print(f"  ответ (первые 500 символов): {r['raw'][:500]}")
            return False

        except Exception as e:
            print(f"\n[РЕГИСТРАЦИЯ ПРЕРВАНА] {type(e).__name__}: {e}")
            return False
