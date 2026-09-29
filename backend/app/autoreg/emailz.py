"""
emailz.py - Получение кода подтверждения Instagram из email или SMS.

Код получается автоматически либо из Outlook/AnyMessage (email),
либо из Textverified (SMS). Интерфейс объединённый — один метод работает
с обоими способами благодаря унифицированному интерфейсу клиентов.
"""

from typing import Optional


def obtain_confirmation_code(reg) -> str:
    """
    Единая точка получения кода верификации. Вызывается из run() после
    инициализации письма/SMS.

    Параметр `reg` - это self твоего InstagramRegistration. Используются поля:
        - mail_client / sms_client: объект клиента (любой из них работает одинаково)
        - email / phone: адрес/номер (если сторона email используется).
        - email_password: пароль (для Outlook)
        - email_folder: папка (для Outlook)
        - code_wait_timeout: макс. время ожидания кода (сек)
        - code_poll_interval: интервал опроса (сек)

    Возвращает 6-значный код.
    Выбрасывает RuntimeError если код не получен.
    """

    # Определяем какой клиент использовать: sms_client или mail_client
    if hasattr(reg, 'sms_client') and reg.sms_client:
        client = reg.sms_client
        contact = reg.phone if hasattr(reg, 'phone') else "unknown"
        contact_type = "SMS"
    elif hasattr(reg, 'mail_client') and reg.mail_client:
        client = reg.mail_client
        contact = reg.email
        contact_type = "Email"
    else:
        raise RuntimeError("Не найден ни sms_client ни mail_client")

    # Используем wait_for_code с параметрами из reg
    code = client.wait_for_code(
        email=contact,
        password=getattr(reg, 'email_password', ''),
        folder=getattr(reg, 'email_folder', 'INBOX'),
        timeout_sec=getattr(reg, 'code_wait_timeout', 120),
        poll_interval_sec=getattr(reg, 'code_poll_interval', 3.0),
        ignore_message_id=getattr(reg, '_prev_msg_id', None),
    )

    if not code:
        timeout = getattr(reg, 'code_wait_timeout', 120)
        raise RuntimeError(
            f"Код не получен из {contact_type} ({contact}) за {timeout} секунд"
        )

    return code
