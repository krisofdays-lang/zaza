"""
identity.py - Рандомизация личности для регистрации:
  * случайные имя/фамилия
  * случайная дата рождения (совершеннолетний возраст)
  * случайный username + проверка его занятости в Instagram

Проверка username делается отдельным запросом к публичному web-эндпоинту
Instagram и НЕ затрагивает запросы самого flow регистрации.
"""

import random
import string
from typing import Optional, Tuple

import requests

try:
    from .fingerprints import configure_session_proxy
except Exception:
    configure_session_proxy = None


# Только женские имена -> username тоже получается женским (строится из имени).
FIRST_NAMES = [
    "Olivia", "Emma", "Charlotte", "Amelia", "Ava", "Sophia", "Isabella", "Mia",
    "Evelyn", "Harper", "Luna", "Camila", "Gianna", "Elizabeth", "Eleanor", "Ella",
    "Sofia", "Avery", "Scarlett", "Emily", "Aria", "Penelope", "Chloe", "Layla",
    "Grace", "Zoey", "Nora", "Riley", "Hannah", "Lily", "Aurora", "Victoria",
    "Stella", "Hazel", "Violet", "Aubrey", "Natalie", "Zoe", "Leah", "Lucy",
    "Ellie", "Savannah", "Maya", "Audrey", "Bella", "Claire", "Skylar", "Paisley",
]

LAST_NAMES = [
    "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis",
    "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson",
    "Thomas", "Taylor", "Moore", "Jackson", "Martin", "Lee", "Perez", "Thompson",
    "White", "Harris", "Sanchez", "Clark", "Ramirez", "Lewis", "Robinson",
]


def random_name() -> Tuple[str, str]:
    """Случайные (first_name, last_name)."""
    return random.choice(FIRST_NAMES), random.choice(LAST_NAMES)


def random_birthday(min_age: int = 18, max_age: int = 45) -> Tuple[int, int, int]:
    """
    Случайная дата рождения в виде (year, month, day) для возраста
    от min_age до max_age лет. День ограничен 28, чтобы не упереться в
    короткие месяцы.
    """
    import datetime
    today = datetime.date.today()
    age = random.randint(min_age, max_age)
    year = today.year - age
    month = random.randint(1, 12)
    day = random.randint(1, 28)
    return year, month, day


def random_username(first_name: str = "", last_name: str = "") -> str:
    """
    Генерирует случайный username на базе имени/фамилии + цифры/разделители.
    Длина в пределах правил Instagram (<=30 символов).
    """
    base_parts = []
    if first_name:
        base_parts.append(first_name.lower())
    if last_name:
        base_parts.append(last_name.lower())
    if not base_parts:
        base_parts.append("".join(random.choices(string.ascii_lowercase, k=6)))

    sep = random.choice(["", "_", ".", "_"])
    base = sep.join(base_parts)
    suffix = str(random.randint(1, 9999))
    candidate = f"{base}{random.choice(['', '_', '.'])}{suffix}"
    candidate = candidate.strip("._")
    return candidate[:30]


def _build_session(proxy: Optional[str]) -> requests.Session:
    s = requests.Session()
    if proxy and configure_session_proxy:
        try:
            configure_session_proxy(s, proxy)
        except Exception:
            pass
    return s


def check_username_available(username: str, proxy: Optional[str] = None,
                             timeout: float = 15.0) -> Optional[bool]:
    """
    Проверяет занятость username через публичный web-эндпоинт Instagram.

    Возвращает:
        True  - свободен
        False - занят
        None  - не удалось определить (сеть/блок) -> вызывающий решает сам
    """
    url = "https://www.instagram.com/api/v1/users/web_profile_info/"
    headers = {
        "x-ig-app-id": "936619743392459",
        "User-Agent": (
            "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) "
            "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"
        ),
        "Accept": "*/*",
    }
    session = _build_session(proxy)
    try:
        resp = session.get(url, params={"username": username},
                           headers=headers, timeout=timeout)
        if resp.status_code == 404:
            return True  # профиля нет -> username свободен
        if resp.status_code == 200:
            try:
                data = resp.json()
            except ValueError:
                return None
            user = (data.get("data") or {}).get("user")
            return user is None  # есть user -> занят
        # 429/прочее - не смогли определить
        return None
    except requests.RequestException:
        return None
    finally:
        try:
            session.close()
        except Exception:
            pass


def generate_unique_username(first_name: str, last_name: str,
                             proxy: Optional[str] = None,
                             max_attempts: int = 10) -> str:
    """
    Генерирует username и проверяет его занятость. Перебирает варианты,
    пока не найдёт свободный (или не исчерпает max_attempts).

    Если проверка недоступна (None), берём текущий кандидат как есть.
    """
    last_candidate = random_username(first_name, last_name)
    for _ in range(max_attempts):
        candidate = random_username(first_name, last_name)
        last_candidate = candidate
        available = check_username_available(candidate, proxy=proxy)
        if available is True:
            print(f"[username] '{candidate}' свободен")
            return candidate
        if available is None:
            print(f"[username] не удалось проверить '{candidate}', беру как есть")
            return candidate
        print(f"[username] '{candidate}' занят, пробую другой")
    return last_candidate
