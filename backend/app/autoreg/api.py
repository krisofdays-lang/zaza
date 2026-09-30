"""FastAPI router for Instagram autoreg.

One registration per API call. The Next.js runner orchestrates parallelism,
batching, and cancellation. This endpoint is synchronous (runs in a thread)
because the registration flow uses requests.Session with time.sleep delays.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import traceback
from typing import Any, Callable, Optional

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

log = logging.getLogger("ig.autoreg")

router = APIRouter(prefix="/autoreg", tags=["autoreg"])


# ── Request / Response models ────────────────────────────────────────────

class AutoregRequest(BaseModel):
    method: str = "email"  # "email" | "sms"
    proxy: str = ""
    ig_password: str = Field(default="zbGB6aA7!", alias="igPassword")

    # Email (AnyMessage) settings
    anymessage_api_key: str = Field(default="", alias="anymessageApiKey")
    anymessage_domain: str = Field(default="gmail", alias="anymessageDomain")
    anymessage_site: str = Field(default="instagram.com", alias="anymessageSite")

    # SMS (TextVerified) settings
    textverified_api_key: str = Field(default="", alias="textverifiedApiKey")
    textverified_username: str = Field(default="", alias="textverifiedUsername")

    # Timing
    step_delay_min: float = Field(default=8.0, alias="stepDelayMin")
    step_delay_max: float = Field(default=22.0, alias="stepDelayMax")
    code_wait_timeout: int = Field(default=60, alias="codeWaitTimeout")
    code_poll_interval: float = Field(default=3.0, alias="codePollInterval")

    model_config = {"populate_by_name": True, "extra": "ignore"}


class AutoregResult(BaseModel):
    success: bool = False
    error: str = ""
    nux_approved: bool = Field(default=False, alias="nuxApproved")

    # Account data
    username: str = ""
    password: str = ""
    email: str = ""
    phone: str = ""

    # Session tokens
    bearer: str = ""
    mid: str = ""
    claim: str = ""
    ds_user_id: str = Field(default="", alias="dsUserId")
    csrf: str = ""
    rur: str = ""

    # Device identifiers
    device_id: str = Field(default="", alias="deviceId")
    family_device_id: str = Field(default="", alias="familyDeviceId")
    phone_id: str = Field(default="", alias="phoneId")
    pigeon_session: str = Field(default="", alias="pigeonSession")
    fb_anon_id: str = Field(default="", alias="fbAnonId")
    waterfall_id: str = Field(default="", alias="waterfallId")
    machine_id: str = Field(default="", alias="machineId")
    cloud_trust_token: str = Field(default="", alias="cloudTrustToken")
    aac_jid: str = Field(default="", alias="aacJid")
    aac_cs: str = Field(default="", alias="aacCs")

    # Device profile
    iphone_model: str = Field(default="", alias="iphoneModel")
    ios_version: str = Field(default="", alias="iosVersion")
    app_version: str = Field(default="", alias="appVersion")
    locale: str = ""
    timezone: str = ""
    user_agent: str = Field(default="", alias="userAgent")

    # Full session blob for transfer
    session_blob: dict = Field(default_factory=dict, alias="sessionBlob")

    # Step log for UI
    steps: list[dict] = Field(default_factory=list)

    model_config = {"populate_by_name": True}


# ── Helpers ──────────────────────────────────────────────────────────────

def _run_registration(
    req: AutoregRequest,
    on_step: Callable[[str, str], None] | None = None,
) -> AutoregResult:
    """Run one registration synchronously (called from a thread)."""
    from .registration import InstagramRegistration
    from .identity import random_name, random_birthday, generate_unique_username
    from .anymessage_client import AnyMessageClient
    from .textverified_client import TextverifiedClient
    from .account_store import build_account_record

    steps: list[dict] = []

    def log_step(step: str, detail: str = ""):
        steps.append({"step": step, "detail": detail, "ts": time.time()})
        log.info("[autoreg] %s: %s", step, detail)
        if on_step:
            on_step(step, detail)

    try:
        first_name, last_name = random_name()
        birthday = random_birthday()
        username = generate_unique_username(first_name, last_name, proxy=req.proxy)
        log_step("init", f"username={username}, proxy={req.proxy[:30]}...")

        mail_client = None
        sms_client = None
        phone = ""
        email = ""
        activation_id = None

        if req.method == "sms":
            sms_client = TextverifiedClient(
                api_key=req.textverified_api_key,
                api_username=req.textverified_username,
            )
            phone, _ = sms_client.order_phone()
            log_step("sms_ordered", f"phone={phone}")
        else:
            am_client = AnyMessageClient(
                token=req.anymessage_api_key,
                site=req.anymessage_site,
                domain=req.anymessage_domain,
            )
            email, activation_id = am_client.order_email()
            mail_client = am_client
            log_step("email_ordered", f"email={email}")

        reg = InstagramRegistration(
            email=email,
            email_password="",
            ig_password=req.ig_password,
            first_name=first_name,
            last_name=last_name,
            birthday=birthday,
            username=username,
            mail_client=mail_client,
            sms_client=sms_client,
            phone=phone,
            proxy=req.proxy,
            step_delay_min=req.step_delay_min,
            step_delay_max=req.step_delay_max,
            code_wait_timeout=req.code_wait_timeout,
            code_poll_interval=req.code_poll_interval,
        )

        # Hook into _update_state_from to log each registration step
        _orig_update = reg._update_state_from
        reg._last_error = ""

        def _hooked_update(resp, step_name):
            log_step(step_name, f"HTTP {resp.get('status_code', '?')}")
            return _orig_update(resp, step_name)

        reg._update_state_from = _hooked_update

        try:
            ok = reg.run()
        except Exception as run_err:
            ok = False
            log_step("exception", f"{type(run_err).__name__}: {run_err}")

        if not ok:
            # Find the actual failure: check for non-200 steps or the last step
            fail_reasons = []
            for s in steps:
                detail = s.get("detail", "")
                if detail and "HTTP" in detail and "200" not in detail:
                    fail_reasons.append(f"{s['step']}: {detail}")
            if not fail_reasons:
                if getattr(reg, "xlsx_status", "") == "banned":
                    fail_reasons.append("Account restricted (UFAC/checkpoint)")
                elif not getattr(reg, "bearer", ""):
                    fail_reasons.append("No bearer token after all steps completed")
                else:
                    fail_reasons.append("Registration unsuccessful")
            fail_reason = "; ".join(fail_reasons)
            log_step("failed", fail_reason)
            return AutoregResult(
                success=False,
                error=fail_reason,
                username=reg.username,
                email=reg.email,
                phone=reg.phone or "",
                bearer=reg.bearer or "",
                mid=reg.mid or "",
                steps=steps,
            )

        if not reg.nux_consent_approved:
            log_step("nux_not_approved", "NUX consent was not approved")
            return AutoregResult(
                success=False,
                error="NUX consent not approved",
                username=reg.username,
                email=reg.email,
                phone=reg.phone or "",
                bearer=reg.bearer or "",
                mid=reg.mid or "",
                steps=steps,
            )

        if not reg.bearer:
            log_step("no_bearer", "Bearer token is empty after registration")
            return AutoregResult(
                success=False,
                error="Bearer token missing after registration",
                username=reg.username,
                email=reg.email,
                phone=reg.phone or "",
                mid=reg.mid or "",
                steps=steps,
            )

        # Build the account record using the same logic as the standalone script
        # We need the last response for build_account_record, but reg.run()
        # doesn't return it. Instead, extract tokens directly from reg object.
        cookies = {}
        try:
            cookies = dict(reg.session.cookies)
        except Exception:
            pass

        session_blob = {
            "session": {
                "authorization": reg.bearer or "",
                "ds_user_id": reg.ds_user_id or "",
                "mid": reg.mid or "",
                "csrf": cookies.get("csrftoken", ""),
                "www_claim": reg.www_claim or "",
            },
            "device": {
                "guid": reg.guid or "",
                "family_device_id": reg.family_device_id or "",
                "phone_id": reg.phone_id or "",
                "device_id": reg.device_id or "",
                "pigeon_session": reg.pigeon_session or "",
                "fb_anon_id": reg.fb_anon_id or "",
                "waterfall_id": reg.waterfall_id or "",
                "reg_flow_id": reg.reg_flow_id or "",
                "aac_jid": reg.aacjid or "",
                "machine_id": reg.machine_id or "",
                "cloud_trust": reg.cloud_trust_token or "",
            },
            "app": {
                "ig_version": getattr(reg, "app_ig_version", ""),
                "app_id": reg.ig_app_id or "",
                "app_version": getattr(reg, "app_version", ""),
                "build_number": getattr(reg, "app_build_number", ""),
                "bloks_version": reg.bloks_versioning_id or "",
            },
        }

        dp = getattr(reg, "device_profile", {}) or {}
        geo = getattr(reg, "geo", {}) or {}

        return AutoregResult(
            success=True,
            nux_approved=reg.nux_consent_approved,
            username=reg.username,
            password=reg.ig_password,
            email=reg.email,
            phone=reg.phone or "",
            bearer=reg.bearer or "",
            mid=reg.mid or "",
            claim=reg.www_claim or "",
            ds_user_id=reg.ds_user_id or "",
            csrf=cookies.get("csrftoken", ""),
            rur=reg.rur or "",
            device_id=reg.device_id or "",
            family_device_id=reg.family_device_id or "",
            phone_id=reg.phone_id or "",
            pigeon_session=reg.pigeon_session or "",
            fb_anon_id=reg.fb_anon_id or "",
            waterfall_id=reg.waterfall_id or "",
            machine_id=reg.machine_id or "",
            cloud_trust_token=reg.cloud_trust_token or "",
            aac_jid=reg.aacjid or "",
            aac_cs=reg.aaccs or "",
            iphone_model=dp.get("model", ""),
            ios_version=dp.get("os_version", ""),
            app_version=getattr(reg, "app_version", ""),
            locale=geo.get("locale", "en_US"),
            timezone=str(geo.get("tz_offset_seconds", "-18000")),
            user_agent=reg.user_agent or "",
            session_blob=session_blob,
            steps=steps,
        )

    except Exception as e:
        log.exception("autoreg failed")
        return AutoregResult(
            success=False,
            error=f"{type(e).__name__}: {e}",
            steps=steps,
        )


# ── Route ────────────────────────────────────────────────────────────────

@router.post("/register")
async def register(req: AutoregRequest):
    """Run one Instagram registration, streaming steps as NDJSON."""
    step_queue: asyncio.Queue = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def on_step(step: str, detail: str):
        loop.call_soon_threadsafe(
            step_queue.put_nowait,
            {"type": "step", "step": step, "detail": detail},
        )

    def run():
        try:
            result = _run_registration(req, on_step=on_step)
            loop.call_soon_threadsafe(
                step_queue.put_nowait,
                {"type": "result", "data": result.model_dump(by_alias=True)},
            )
        except Exception as e:
            err = AutoregResult(success=False, error=f"{type(e).__name__}: {e}")
            loop.call_soon_threadsafe(
                step_queue.put_nowait,
                {"type": "result", "data": err.model_dump(by_alias=True)},
            )

    loop.run_in_executor(None, run)

    async def generate():
        while True:
            item = await step_queue.get()
            yield json.dumps(item) + "\n"
            if item.get("type") == "result":
                break

    return StreamingResponse(generate(), media_type="application/x-ndjson")


@router.get("/health")
def autoreg_health() -> dict:
    return {"status": "ok", "service": "autoreg"}
