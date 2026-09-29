"""
account_store.py — Сохранение созданных аккаунтов Instagram в xlsx.

НОВЫЙ ФОРМАТ (5 колонок):
    1) account   — структурированная запись аккаунта в компактном JSON
                   (session / device / app / ua_profile), собранная из ответов
                   на запросы регистрации, включая финальный create.account.
    2) account_b64 — base64 первой колонки (та же JSON-строка в кодировке UTF-8).
    3) proxy     — прокси, который использовался для этого аккаунта.
    4) username  — логин созданного аккаунта.
    5) password  — пароль созданного аккаунта.

В таблицу пишутся ТОЛЬКО успешно созданные аккаунты (гейтинг — в
instagram_caa_reg: banned/no_bearer отсекаются, запись откладывается до APPROVED).

totp_seed (2FA) по требованию оставляем ПУСТЫМ.

Запись потокобезопасна и безопасна между процессами:
  * threading.Lock  — защищает запись между потоками одного процесса
  * FileLock (.lock) — защищает запись между несколькими процессами
"""

import os
import re
import time
import json
import base64
import threading
from typing import Any, Dict

from openpyxl import Workbook, load_workbook
from filelock import FileLock


ACCOUNTS_XLSX = "accounts.xlsx"

# Пять колонок нового формата.
COLUMNS = ["account", "account_b64", "proxy", "username", "password"]

COLUMN_WIDTHS = {
    "account": 120,
    "account_b64": 120,
    "proxy": 64,
    "username": 28,
    "password": 24,
}

# Представительная IANA-таймзона по стране прокси (для ua_profile.tz_name).
# Оффсет по-прежнему берём из geo (resolve_geo по IP), а имя зоны выбираем как
# типичное для страны — этого достаточно для согласованного фингерпринта.
_TZ_NAME_BY_COUNTRY = {
    "US": "America/New_York", "GB": "Europe/London", "CA": "America/Toronto",
    "AU": "Australia/Sydney", "DE": "Europe/Berlin", "FR": "Europe/Paris",
    "ES": "Europe/Madrid", "IT": "Europe/Rome", "BR": "America/Sao_Paulo",
    "PT": "Europe/Lisbon", "RU": "Europe/Moscow", "TR": "Europe/Istanbul",
    "TH": "Asia/Bangkok", "ID": "Asia/Jakarta", "VN": "Asia/Ho_Chi_Minh",
    "IN": "Asia/Kolkata", "JP": "Asia/Tokyo", "KR": "Asia/Seoul",
    "MX": "America/Mexico_City", "PH": "Asia/Manila", "NL": "Europe/Amsterdam",
    "PL": "Europe/Warsaw", "SE": "Europe/Stockholm",
}

# Один замок на процесс (между потоками) + файловый замок (между процессами).
_thread_lock = threading.Lock()


def _apply_column_widths(ws) -> None:
    from openpyxl.utils import get_column_letter
    for idx, col in enumerate(COLUMNS, start=1):
        letter = get_column_letter(idx)
        ws.column_dimensions[letter].width = COLUMN_WIDTHS.get(col, 40)


def _unescape(s: str) -> str:
    """Снимает JSON-экранирование (\\\" -> \", \\/ -> /, \\\\ -> \\)."""
    if not s:
        return ""
    return s.replace("\\\\", "\\").replace('\\"', '"').replace("\\/", "/")


def extract_www_claim(raw: str) -> str:
    """x-ig-set-www-claim приходит и в теле ответа как экранированная строка.
    Ищем значение вида hmac.<base64url> в исходном и в разэкранированном теле."""
    if not raw:
        return ""
    for text in (raw, _unescape(raw)):
        m = re.search(r"(hmac\.[A-Za-z0-9_\-]{16,})", text)
        if m:
            return m.group(1)
    return ""


def extract_bearer(raw: str) -> str:
    """bearer (ig-set-authorization) приходит как "Bearer IGT:2:<base64>" и
    может лежать в теле ответа в экранированном виде."""
    if not raw:
        return ""
    for text in (raw, _unescape(raw)):
        m = re.search(r"(Bearer\s+IGT:2:[A-Za-z0-9+/=_\-]+)", text)
        if m:
            return m.group(1)
    return ""


def _extract_ds_user_id(h: Dict[str, str], cookies: Dict[str, str], raw: str) -> str:
    """ds_user_id: заголовок -> cookie -> тело ответа (несколько форматов)."""
    val = h.get("ig-set-ig-u-ds-user-id") or cookies.get("ds_user_id", "")
    if val:
        return str(val)
    patterns = [
        r'"(?:pk|user_id|ds_user_id)"\s*:\s*"?(\d{6,})"?',
        r'\(eud\s+(\d{6,})\)',
        r'ds_user_id["\s:=]+(\d{6,})',
    ]
    for pat in patterns:
        m = re.search(pat, raw)
        if m:
            return m.group(1)
    return ""


def _as_int_or_str(value: str):
    """ds_user_id в формате экспорта — число, если это чистые цифры."""
    s = str(value or "")
    return int(s) if s.isdigit() else s


def _build_ua_profile(reg) -> Dict[str, Any]:
    """Секция ua_profile: устройство (модель/экран/iOS) + гео (locale/country/tz)."""
    dp = getattr(reg, "device_profile", None) or {}
    geo = getattr(reg, "geo", None) or {}
    build_profile = getattr(reg, "build_profile", None) or {}

    # Полная версия UA ("447.0.0.34.80"): из build_profile, иначе парсим из UA.
    ua_version = build_profile.get("ig_version") or ""
    if not ua_version:
        m = re.search(r"Instagram\s+([0-9.]+)\s*\(", getattr(reg, "user_agent", "") or "")
        ua_version = m.group(1) if m else ""

    country = (geo.get("country") or "US").upper()
    locale = geo.get("locale") or "en_US"
    tz_name = _TZ_NAME_BY_COUNTRY.get(country, "America/New_York")

    return {
        "ua_version": ua_version,
        "device_model": dp.get("model", ""),
        "os_version": dp.get("os_version", ""),
        "os_ver_dotted": dp.get("os_ver_dotted", dp.get("os_version", "")),
        "os_build": dp.get("os_build", ""),
        "locale": locale,
        "country": country,
        "tz_name": tz_name,
        "scale": dp.get("scale", ""),
        "resolution": dp.get("res", ""),
        "w_logical": dp.get("w_logical", 0),
        "h_logical": dp.get("h_logical", 0),
        "ios_ver": dp.get("ios_ver", ""),
    }


def build_account_record(reg, resp: Dict[str, Any], banned: bool = False) -> Dict[str, Any]:
    """
    Собирает данные аккаунта из объекта регистрации и ответа ФИНАЛЬНОГО шага и
    формирует структуру нового формата экспорта.

    Возвращает dict:
      {
        "_account": {...},   # объект аккаунта -> идёт в колонку "account"
        "proxy": str,        # колонка "proxy"
        "bearer": str,       # для гейтинга в instagram_caa_reg (no_bearer)
        "ban": "worked"|"banned",   # для лога сохранения
        "ds_user_id": str,          # для лога сохранения
      }

    www-claim / ds_user_id / bearer Instagram отдаёт в ЗАГОЛОВКАХ ответа, но не
    обязательно на самом последнем шаге — объект регистрации копит их на каждом
    шаге (reg.www_claim / reg.bearer / reg.ds_user_id). Берём сначала эти
    накопленные значения, иначе — заголовки финального ответа / cookies / тело.
    """
    headers = resp.get("headers") or {}
    h = {str(k).lower(): v for k, v in headers.items()}
    cookies = {}
    try:
        cookies = dict(reg.session.cookies)
    except Exception:
        pass
    raw = resp.get("raw") or ""

    x_mid = (
        getattr(reg, "mid", "")
        or h.get("ig-set-x-mid", "")
        or cookies.get("mid", "")
    )
    www_claim = getattr(reg, "www_claim", "") or h.get("x-ig-set-www-claim", "")
    if www_claim == "0":
        www_claim = ""
    if not www_claim:
        www_claim = extract_www_claim(raw)
    bearer = getattr(reg, "bearer", "") or h.get("ig-set-authorization", "")
    if not bearer:
        bearer = extract_bearer(raw)
    ds_user_id = getattr(reg, "ds_user_id", "") or _extract_ds_user_id(h, cookies, raw)
    csrf = cookies.get("csrftoken", "")

    account = {
        "saved_at": int(time.time()),
        "username": getattr(reg, "username", "") or "",
        "password": getattr(reg, "ig_password", "") or "",
        # totp_seed = 2FA: по требованию оставляем пустым.
        "totp_seed": "",
        "email": getattr(reg, "email", "") or "",
        "session": {
            "authorization": bearer or "",
            "ds_user_id": _as_int_or_str(ds_user_id),
            "mid": x_mid or "",
            "csrf": csrf or "",
            "www_claim": www_claim or "",
        },
        "device": {
            "guid": getattr(reg, "guid", "") or "",
            "family_device_id": getattr(reg, "family_device_id", "") or "",
            "phone_id": getattr(reg, "phone_id", "") or "",
            "device_id": getattr(reg, "device_id", "") or "",
            "pigeon_session": getattr(reg, "pigeon_session", "") or "",
            "fb_anon_id": getattr(reg, "fb_anon_id", "") or "",
            "waterfall_id": getattr(reg, "waterfall_id", "") or "",
            "network_bssid": "",
            "reg_flow_id": getattr(reg, "reg_flow_id", "") or "",
            "aac_jid": getattr(reg, "aacjid", "") or "",
            "machine_id": getattr(reg, "machine_id", "") or "",
            "cloud_trust": getattr(reg, "cloud_trust_token", "") or "",
        },
        "app": {
            "ig_version": getattr(reg, "app_ig_version", "") or "",
            "app_id": getattr(reg, "ig_app_id", "") or "",
            "app_version": getattr(reg, "app_version", "") or "",
            "build_number": getattr(reg, "app_build_number", "") or "",
            "bloks_version": getattr(reg, "bloks_versioning_id", "") or "",
        },
        "ua_profile": _build_ua_profile(reg),
        "cookies": [],
    }

    return {
        "_account": account,
        "proxy": getattr(reg, "proxy", "") or "",
        "username": getattr(reg, "username", "") or "",
        "password": getattr(reg, "ig_password", "") or "",
        "bearer": bearer or "",
        "ban": "banned" if banned else "worked",
        "ds_user_id": str(ds_user_id or ""),
    }


def _serialize_columns(record: Dict[str, Any]) -> Dict[str, str]:
    """Готовит пять колонок: компактный JSON, его base64, прокси, логин, пароль."""
    account_json = json.dumps(
        record.get("_account") or {},
        separators=(",", ":"),
        ensure_ascii=False,
    )
    account_b64 = base64.b64encode(account_json.encode("utf-8")).decode("ascii")
    return {
        "account": account_json,
        "account_b64": account_b64,
        "proxy": record.get("proxy", "") or "",
        "username": record.get("username", "") or "",
        "password": record.get("password", "") or "",
    }


def save_account(record: Dict[str, Any], path: str = ACCOUNTS_XLSX) -> None:
    """
    Дописывает аккаунт в xlsx (3 колонки). Создаёт файл с шапкой, если его нет.

    Безопасно при параллельном запуске:
      * threading.Lock — сериализует потоки одного процесса
      * FileLock       — сериализует разные процессы (через файл <path>.lock)
    """
    cols = _serialize_columns(record)
    file_lock = FileLock(f"{path}.lock", timeout=60)
    with _thread_lock, file_lock:
        if os.path.exists(path):
            wb = load_workbook(path)
            ws = wb.active
        else:
            wb = Workbook()
            ws = wb.active
            ws.title = "accounts"
            ws.append(COLUMNS)

        ws.append([cols.get(col, "") for col in COLUMNS])
        _apply_column_widths(ws)
        wb.save(path)
