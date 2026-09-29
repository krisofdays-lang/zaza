"""Pydantic request/response models.

The Python service is intentionally stateless about the database: Next.js owns
the DB + media storage and passes the full account fingerprint on each call. Any
server-issued values worth persisting (the refreshed www-claim / regional rur)
are returned so the caller can write them back.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class Account(BaseModel):
    """Mirror of the fields the TS InstagramClient reads off an igAccounts row.

    Names use snake_case with camelCase aliases so Next.js can send its Drizzle
    row shape unchanged (populate_by_name lets either form parse).
    """

    id: int = 0
    ig_user_id: str = Field(default="", alias="igUserId")
    bearer_token: str = Field(default="", alias="bearerToken")
    mid: str = ""
    claim: str = "SKIP"
    device_id: str = Field(default="", alias="deviceId")
    family_device_id: str = Field(default="", alias="familyDeviceId")
    phone_id_field: str = Field(default="", alias="phoneId")
    cloud_trust_token: str = Field(default="", alias="cloudTrustToken")
    proxy_type: str = Field(default="none", alias="proxyType")
    proxy_url: str = Field(default="", alias="proxyUrl")
    rotation_url: str = Field(default="", alias="rotationUrl")
    iphone_model: str = Field(default="iPhone17,1", alias="iphoneModel")
    ios_version: str = Field(default="18_5", alias="iosVersion")
    app_version: str = Field(default="437.0.0.22.50", alias="appVersion")
    locale: str = "en_US"
    timezone: str = "Europe/Moscow"
    user_agent: str = Field(default="", alias="userAgent")
    clock_offset_ms: int = Field(default=0, alias="clockOffsetMs")
    prng_seed: str = Field(default="", alias="prngSeed")

    model_config = {"populate_by_name": True, "extra": "ignore"}


class ReelPublishRequest(BaseModel):
    """One reel publish for one account. Next.js base64-encodes the video bytes
    (read from its own media storage) and sends the full account fingerprint."""

    account: Account
    video_base64: str = Field(alias="videoBase64")
    caption: str | None = ""
    fallback_width: int | None = Field(default=None, alias="fallbackWidth")
    fallback_height: int | None = Field(default=None, alias="fallbackHeight")
    # Human-pause overrides: an object of [min,max] ms ranges, or false to disable
    # all artificial delays (e.g. bulk backfills).
    delays: dict | bool | None = None

    model_config = {"populate_by_name": True, "extra": "ignore"}


class ReelPublishResponse(BaseModel):
    ok: bool
    status: int
    detail: str | None = None
    upload_id: str = Field(serialization_alias="uploadId")
    # Server-issued state the caller should persist back onto the account row.
    claim: str | None = None
    rur: str | None = None

    model_config = {"populate_by_name": True}
