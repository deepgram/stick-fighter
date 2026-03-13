"""OAuth2/OIDC authentication module for id.dx.deepgram.com.

Handles token exchange, refresh, and userinfo fetching.
Configuration via environment variables:
  OIDC_ISSUER        — OIDC issuer URL (default: https://id.dx.deepgram.com)
  OIDC_CLIENT_ID     — OAuth2 client ID
  OIDC_CLIENT_SECRET — OAuth2 client secret
"""

from __future__ import annotations

import base64
import json
import os
from dataclasses import dataclass

import httpx


@dataclass
class OIDCConfig:
    """OIDC provider configuration."""

    issuer: str
    client_id: str
    client_secret: str
    authorization_endpoint: str
    token_endpoint: str
    userinfo_endpoint: str
    scopes: str = "openid profile email"

    @classmethod
    def from_env(cls) -> OIDCConfig:
        """Load OIDC config from environment variables."""
        issuer = os.environ.get("OIDC_ISSUER", "https://id.dx.deepgram.com")
        client_id = os.environ.get("OIDC_CLIENT_ID", "")
        client_secret = os.environ.get("OIDC_CLIENT_SECRET", "")

        # Default endpoints derived from issuer (standard OIDC convention)
        authorization_endpoint = os.environ.get(
            "OIDC_AUTHORIZATION_ENDPOINT",
            f"{issuer}/authorize",
        )
        token_endpoint = os.environ.get(
            "OIDC_TOKEN_ENDPOINT",
            f"{issuer}/oauth/token",
        )
        userinfo_endpoint = os.environ.get(
            "OIDC_USERINFO_ENDPOINT",
            f"{issuer}/userinfo",
        )

        return cls(
            issuer=issuer,
            client_id=client_id,
            client_secret=client_secret,
            authorization_endpoint=authorization_endpoint,
            token_endpoint=token_endpoint,
            userinfo_endpoint=userinfo_endpoint,
        )

    @property
    def configured(self) -> bool:
        """Check if OIDC is properly configured (client_id is required at minimum)."""
        return bool(self.client_id)


def decode_id_token_payload(id_token: str) -> dict:
    """Decode the payload of a JWT ID token (without signature verification).

    This is safe when the token comes directly from the token endpoint over HTTPS.
    For production use, you'd want to verify the signature using the provider's JWKS.
    """
    parts = id_token.split(".")
    if len(parts) != 3:
        return {}

    # Decode the payload (second part) — add padding as needed
    payload_b64 = parts[1]
    padding = 4 - len(payload_b64) % 4
    if padding != 4:
        payload_b64 += "=" * padding

    try:
        payload_bytes = base64.urlsafe_b64decode(payload_b64)
        return json.loads(payload_bytes)
    except (ValueError, json.JSONDecodeError):
        return {}


async def exchange_code(
    config: OIDCConfig, code: str, redirect_uri: str
) -> dict:
    """Exchange an authorization code for tokens.

    Returns the raw token response dict (access_token, id_token, refresh_token, etc.)
    """
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            config.token_endpoint,
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirect_uri,
                "client_id": config.client_id,
                "client_secret": config.client_secret,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )

    if resp.status_code != 200:
        return {"error": "token_exchange_failed", "detail": resp.text}

    return resp.json()


async def refresh_tokens(config: OIDCConfig, refresh_token: str) -> dict:
    """Refresh tokens using a refresh_token.

    Returns the raw token response dict.
    """
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            config.token_endpoint,
            data={
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
                "client_id": config.client_id,
                "client_secret": config.client_secret,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )

    if resp.status_code != 200:
        return {"error": "refresh_failed", "detail": resp.text}

    return resp.json()


async def fetch_userinfo(config: OIDCConfig, access_token: str) -> dict:
    """Fetch user profile from the OIDC userinfo endpoint."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            config.userinfo_endpoint,
            headers={"Authorization": f"Bearer {access_token}"},
        )

    if resp.status_code != 200:
        return {"error": "userinfo_failed", "detail": resp.text}

    return resp.json()


def extract_user_from_id_token(id_token: str) -> dict:
    """Extract user info from an ID token payload.

    Returns a normalized user dict with id, name, and email.
    """
    claims = decode_id_token_payload(id_token)
    if not claims:
        return {}

    return {
        "id": claims.get("sub", ""),
        "name": claims.get("name", claims.get("nickname", claims.get("email", ""))),
        "email": claims.get("email", ""),
    }
