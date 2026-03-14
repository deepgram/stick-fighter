"""Tests for auth.py and auth endpoints in server.py."""

from __future__ import annotations

import base64
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from litestar.testing import TestClient

import server
from auth import OIDCConfig, decode_id_token_payload, extract_user_from_id_token
from server import app


# ─── OIDCConfig ──────────────────────────────


class TestOIDCConfig:
    def test_from_env_defaults(self) -> None:
        with patch.dict("os.environ", {}, clear=True):
            config = OIDCConfig.from_env()
        assert config.issuer == "https://id.dx.deepgram.com"
        assert config.client_id == ""
        assert config.client_secret == ""
        assert config.authorization_endpoint == "https://id.dx.deepgram.com/authorize"
        assert config.token_endpoint == "https://id.dx.deepgram.com/token"
        assert config.userinfo_endpoint == "https://id.dx.deepgram.com/userinfo"

    def test_from_env_custom(self) -> None:
        env = {
            "OIDC_ISSUER": "https://auth.example.com",
            "OIDC_CLIENT_ID": "my-client",
            "OIDC_CLIENT_SECRET": "my-secret",
            "OIDC_AUTHORIZATION_ENDPOINT": "https://auth.example.com/auth",
            "OIDC_TOKEN_ENDPOINT": "https://auth.example.com/token",
            "OIDC_USERINFO_ENDPOINT": "https://auth.example.com/me",
        }
        with patch.dict("os.environ", env, clear=True):
            config = OIDCConfig.from_env()
        assert config.issuer == "https://auth.example.com"
        assert config.client_id == "my-client"
        assert config.client_secret == "my-secret"
        assert config.authorization_endpoint == "https://auth.example.com/auth"
        assert config.token_endpoint == "https://auth.example.com/token"
        assert config.userinfo_endpoint == "https://auth.example.com/me"

    def test_configured_true(self) -> None:
        config = OIDCConfig(
            issuer="https://example.com",
            client_id="abc",
            client_secret="def",
            authorization_endpoint="https://example.com/auth",
            token_endpoint="https://example.com/token",
            userinfo_endpoint="https://example.com/userinfo",
        )
        assert config.configured is True

    def test_configured_false_when_no_client_id(self) -> None:
        config = OIDCConfig(
            issuer="https://example.com",
            client_id="",
            client_secret="",
            authorization_endpoint="",
            token_endpoint="",
            userinfo_endpoint="",
        )
        assert config.configured is False


# ─── JWT decoding ────────────────────────────


def _make_jwt(payload: dict) -> str:
    """Create a fake JWT with the given payload (no signature verification)."""
    header = base64.urlsafe_b64encode(json.dumps({"alg": "RS256"}).encode()).rstrip(b"=").decode()
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
    sig = base64.urlsafe_b64encode(b"fake-signature").rstrip(b"=").decode()
    return f"{header}.{body}.{sig}"


class TestDecodeIdToken:
    def test_decode_valid_jwt(self) -> None:
        token = _make_jwt({"sub": "user-123", "name": "Alice", "email": "alice@example.com"})
        claims = decode_id_token_payload(token)
        assert claims["sub"] == "user-123"
        assert claims["name"] == "Alice"
        assert claims["email"] == "alice@example.com"

    def test_decode_invalid_jwt_format(self) -> None:
        assert decode_id_token_payload("not-a-jwt") == {}

    def test_decode_empty_string(self) -> None:
        assert decode_id_token_payload("") == {}

    def test_decode_malformed_base64(self) -> None:
        assert decode_id_token_payload("a.!!!.c") == {}


class TestExtractUser:
    def test_extract_user_with_name(self) -> None:
        token = _make_jwt({"sub": "u1", "name": "Bob", "email": "bob@test.com"})
        user = extract_user_from_id_token(token)
        assert user == {"id": "u1", "name": "Bob", "email": "bob@test.com"}

    def test_extract_user_fallback_to_nickname(self) -> None:
        token = _make_jwt({"sub": "u2", "nickname": "bobby", "email": "bob@test.com"})
        user = extract_user_from_id_token(token)
        assert user["name"] == "bobby"

    def test_extract_user_fallback_to_email(self) -> None:
        token = _make_jwt({"sub": "u3", "email": "bob@test.com"})
        user = extract_user_from_id_token(token)
        assert user["name"] == "bob@test.com"

    def test_extract_user_invalid_token(self) -> None:
        assert extract_user_from_id_token("bad") == {}


# ─── Auth config endpoint ────────────────────


class TestAuthConfig:
    def test_config_when_not_configured(self) -> None:
        with TestClient(app=app) as client:
            server.oidc_config = OIDCConfig(
                issuer="", client_id="", client_secret="",
                authorization_endpoint="", token_endpoint="", userinfo_endpoint="",
            )
            resp = client.get("/api/auth/config")
            assert resp.status_code == 200
            assert resp.json()["configured"] is False
            server.oidc_config = None

    def test_config_when_configured(self) -> None:
        with TestClient(app=app) as client:
            server.oidc_config = OIDCConfig(
                issuer="https://id.dx.deepgram.com",
                client_id="test-client-id",
                client_secret="test-secret",
                authorization_endpoint="https://id.dx.deepgram.com/authorize",
                token_endpoint="https://id.dx.deepgram.com/token",
                userinfo_endpoint="https://id.dx.deepgram.com/userinfo",
            )
            resp = client.get("/api/auth/config")
            data = resp.json()
            assert data["configured"] is True
            assert data["clientId"] == "test-client-id"
            assert data["authorizationEndpoint"] == "https://id.dx.deepgram.com/authorize"
            assert data["tokenEndpoint"] == "https://id.dx.deepgram.com/token"
            assert data["scopes"] == "openid profile email"
            assert "/auth/callback" in data["redirectUri"]
            server.oidc_config = None

    def test_config_when_oidc_none(self) -> None:
        with TestClient(app=app) as client:
            server.oidc_config = None
            resp = client.get("/api/auth/config")
            assert resp.status_code == 200
            assert resp.json()["configured"] is False


# ─── Auth token endpoint ─────────────────────


class TestAuthToken:
    def _get_test_config(self) -> OIDCConfig:
        return OIDCConfig(
            issuer="https://id.dx.deepgram.com",
            client_id="test-client",
            client_secret="test-secret",
            authorization_endpoint="https://id.dx.deepgram.com/authorize",
            token_endpoint="https://id.dx.deepgram.com/oauth/token",
            userinfo_endpoint="https://id.dx.deepgram.com/userinfo",
        )

    def test_token_exchange_missing_code(self) -> None:
        with TestClient(app=app) as client:
            server.oidc_config = self._get_test_config()
            resp = client.post(
                "/api/auth/token",
                content=json.dumps({"code": ""}),
                headers={"Content-Type": "application/json"},
            )
            assert resp.status_code == 400
            server.oidc_config = None

    def test_token_exchange_not_configured(self) -> None:
        with TestClient(app=app) as client:
            server.oidc_config = None
            resp = client.post(
                "/api/auth/token",
                content=json.dumps({"code": "abc"}),
                headers={"Content-Type": "application/json"},
            )
            assert resp.status_code == 503

    @patch("server.exchange_code", new_callable=AsyncMock)
    def test_token_exchange_success(self, mock_exchange) -> None:
        id_token = _make_jwt({"sub": "u1", "name": "Alice", "email": "a@b.com"})
        mock_exchange.return_value = {
            "access_token": "at-123",
            "id_token": id_token,
            "refresh_token": "rt-456",
            "expires_in": 3600,
        }
        with TestClient(app=app) as client:
            server.oidc_config = self._get_test_config()
            resp = client.post(
                "/api/auth/token",
                content=json.dumps({"code": "test-code"}),
                headers={"Content-Type": "application/json"},
            )
            assert resp.status_code == 201
            data = resp.json()
            assert data["access_token"] == "at-123"
            assert data["user"]["name"] == "Alice"
            assert data["user"]["id"] == "u1"
            server.oidc_config = None

    @patch("server.exchange_code", new_callable=AsyncMock)
    def test_token_exchange_provider_error(self, mock_exchange) -> None:
        mock_exchange.return_value = {"error": "invalid_grant", "detail": "bad code"}
        with TestClient(app=app) as client:
            server.oidc_config = self._get_test_config()
            resp = client.post(
                "/api/auth/token",
                content=json.dumps({"code": "bad-code"}),
                headers={"Content-Type": "application/json"},
            )
            assert resp.status_code == 502
            server.oidc_config = None

    @patch("server.exchange_code", new_callable=AsyncMock)
    def test_token_exchange_forwards_code_verifier(self, mock_exchange) -> None:
        id_token = _make_jwt({"sub": "u1", "name": "Alice", "email": "a@b.com"})
        mock_exchange.return_value = {
            "access_token": "at-pkce",
            "id_token": id_token,
            "refresh_token": "rt-pkce",
            "expires_in": 3600,
        }
        with TestClient(app=app) as client:
            server.oidc_config = self._get_test_config()
            resp = client.post(
                "/api/auth/token",
                content=json.dumps({
                    "code": "test-code",
                    "code_verifier": "abc123verifier",
                }),
                headers={"Content-Type": "application/json"},
            )
            assert resp.status_code == 201
            # Verify code_verifier was forwarded to exchange_code
            _, kwargs = mock_exchange.call_args
            assert kwargs.get("code_verifier") == "abc123verifier"
            server.oidc_config = None


# ─── Auth PKCE (exchange_code) ──────────────


class TestExchangeCodePKCE:
    """Test that exchange_code handles PKCE code_verifier and optional client_secret."""

    def _get_pkce_config(self) -> OIDCConfig:
        """Config without client_secret (public PKCE client)."""
        return OIDCConfig(
            issuer="https://id.dx.deepgram.com",
            client_id="stick-fighter",
            client_secret="",
            authorization_endpoint="https://id.dx.deepgram.com/authorize",
            token_endpoint="https://id.dx.deepgram.com/token",
            userinfo_endpoint="https://id.dx.deepgram.com/userinfo",
        )

    @pytest.mark.asyncio
    @patch("auth.httpx.AsyncClient")
    async def test_pkce_sends_code_verifier_not_secret(self, mock_client_cls) -> None:
        """When code_verifier is provided, it should be sent instead of client_secret."""
        import auth

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"access_token": "at-1", "id_token": "", "expires_in": 3600}

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_resp
        mock_client.__aenter__.return_value = mock_client
        mock_client.__aexit__.return_value = False
        mock_client_cls.return_value = mock_client

        config = self._get_pkce_config()
        result = await auth.exchange_code(config, "code-123", "http://localhost/cb", code_verifier="my-verifier")

        assert result["access_token"] == "at-1"
        # Verify the POST data included code_verifier and NOT client_secret
        call_kwargs = mock_client.post.call_args
        sent_data = call_kwargs.kwargs.get("data", call_kwargs[1].get("data", {}))
        assert sent_data["code_verifier"] == "my-verifier"
        assert "client_secret" not in sent_data

    @pytest.mark.asyncio
    @patch("auth.httpx.AsyncClient")
    async def test_secret_sent_when_no_verifier(self, mock_client_cls) -> None:
        """When no code_verifier is provided, client_secret should be sent."""
        import auth

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"access_token": "at-2"}

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_resp
        mock_client.__aenter__.return_value = mock_client
        mock_client.__aexit__.return_value = False
        mock_client_cls.return_value = mock_client

        config = OIDCConfig(
            issuer="https://id.dx.deepgram.com",
            client_id="test",
            client_secret="my-secret",
            authorization_endpoint="",
            token_endpoint="https://id.dx.deepgram.com/token",
            userinfo_endpoint="",
        )
        result = await auth.exchange_code(config, "code-123", "http://localhost/cb")

        assert result["access_token"] == "at-2"
        call_kwargs = mock_client.post.call_args
        sent_data = call_kwargs.kwargs.get("data", call_kwargs[1].get("data", {}))
        assert sent_data["client_secret"] == "my-secret"
        assert "code_verifier" not in sent_data


# ─── Auth refresh endpoint ───────────────────


class TestAuthRefresh:
    def _get_test_config(self) -> OIDCConfig:
        return OIDCConfig(
            issuer="https://id.dx.deepgram.com",
            client_id="test-client",
            client_secret="test-secret",
            authorization_endpoint="https://id.dx.deepgram.com/authorize",
            token_endpoint="https://id.dx.deepgram.com/oauth/token",
            userinfo_endpoint="https://id.dx.deepgram.com/userinfo",
        )

    def test_refresh_missing_token(self) -> None:
        with TestClient(app=app) as client:
            server.oidc_config = self._get_test_config()
            resp = client.post(
                "/api/auth/refresh",
                content=json.dumps({"refresh_token": ""}),
                headers={"Content-Type": "application/json"},
            )
            assert resp.status_code == 400
            server.oidc_config = None

    def test_refresh_not_configured(self) -> None:
        with TestClient(app=app) as client:
            server.oidc_config = None
            resp = client.post(
                "/api/auth/refresh",
                content=json.dumps({"refresh_token": "rt-123"}),
                headers={"Content-Type": "application/json"},
            )
            assert resp.status_code == 503

    @patch("server.refresh_tokens", new_callable=AsyncMock)
    def test_refresh_success(self, mock_refresh) -> None:
        id_token = _make_jwt({"sub": "u1", "name": "Alice"})
        mock_refresh.return_value = {
            "access_token": "new-at",
            "id_token": id_token,
            "refresh_token": "new-rt",
            "expires_in": 3600,
        }
        with TestClient(app=app) as client:
            server.oidc_config = self._get_test_config()
            resp = client.post(
                "/api/auth/refresh",
                content=json.dumps({"refresh_token": "old-rt"}),
                headers={"Content-Type": "application/json"},
            )
            assert resp.status_code == 201
            data = resp.json()
            assert data["access_token"] == "new-at"
            server.oidc_config = None

    @patch("server.refresh_tokens", new_callable=AsyncMock)
    def test_refresh_provider_error(self, mock_refresh) -> None:
        mock_refresh.return_value = {"error": "invalid_grant"}
        with TestClient(app=app) as client:
            server.oidc_config = self._get_test_config()
            resp = client.post(
                "/api/auth/refresh",
                content=json.dumps({"refresh_token": "expired-rt"}),
                headers={"Content-Type": "application/json"},
            )
            assert resp.status_code == 502
            server.oidc_config = None


# ─── Auth me endpoint ────────────────────────


class TestAuthMe:
    def _get_test_config(self) -> OIDCConfig:
        return OIDCConfig(
            issuer="https://id.dx.deepgram.com",
            client_id="test-client",
            client_secret="test-secret",
            authorization_endpoint="https://id.dx.deepgram.com/authorize",
            token_endpoint="https://id.dx.deepgram.com/oauth/token",
            userinfo_endpoint="https://id.dx.deepgram.com/userinfo",
        )

    def test_me_no_token(self) -> None:
        with TestClient(app=app) as client:
            server.oidc_config = self._get_test_config()
            resp = client.get("/api/auth/me")
            assert resp.status_code == 401
            server.oidc_config = None

    def test_me_not_configured(self) -> None:
        with TestClient(app=app) as client:
            server.oidc_config = None
            resp = client.get(
                "/api/auth/me",
                headers={"Authorization": "Bearer token"},
            )
            assert resp.status_code == 503

    @patch("server.fetch_userinfo", new_callable=AsyncMock)
    def test_me_success(self, mock_userinfo) -> None:
        mock_userinfo.return_value = {
            "sub": "u1",
            "name": "Alice",
            "email": "alice@example.com",
        }
        with TestClient(app=app) as client:
            server.oidc_config = self._get_test_config()
            resp = client.get(
                "/api/auth/me",
                headers={"Authorization": "Bearer valid-token"},
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data["id"] == "u1"
            assert data["name"] == "Alice"
            server.oidc_config = None

    @patch("server.fetch_userinfo", new_callable=AsyncMock)
    def test_me_invalid_token(self, mock_userinfo) -> None:
        mock_userinfo.return_value = {"error": "invalid_token"}
        with TestClient(app=app) as client:
            server.oidc_config = self._get_test_config()
            resp = client.get(
                "/api/auth/me",
                headers={"Authorization": "Bearer bad-token"},
            )
            assert resp.status_code == 401
            server.oidc_config = None


# ─── Auth callback route ─────────────────────


class TestAuthCallbackRoute:
    def test_callback_serves_html(self) -> None:
        with TestClient(app=app) as client:
            resp = client.get("/auth/callback?code=abc&state=xyz")
            assert resp.status_code == 200
            assert "text/html" in resp.headers["content-type"]
            assert "STICK FIGHTER" in resp.text


# ─── Multiplayer route ──────────────────────


class TestMultiplayerRoute:
    def test_multiplayer_serves_html(self) -> None:
        with TestClient(app=app) as client:
            resp = client.get("/multiplayer")
            assert resp.status_code == 200
            assert "text/html" in resp.headers["content-type"]
            assert "STICK FIGHTER" in resp.text
