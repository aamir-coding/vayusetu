"""requests session with bounded retries on 429/5xx. Every external call in
ingestion goes through this so a flaky upstream fails the JOB loudly after
retries -- never a silent empty result (the IMD job's old failure mode)."""

from __future__ import annotations

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

DEFAULT_TIMEOUT_S = 30


def session() -> requests.Session:
    s = requests.Session()
    retry = Retry(
        total=4,
        backoff_factor=1.5,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset({"GET", "POST"}),
        raise_on_status=False,
    )
    s.mount("https://", HTTPAdapter(max_retries=retry))
    return s


def get_json(s: requests.Session, url: str, **kwargs) -> dict:
    resp = s.get(url, timeout=DEFAULT_TIMEOUT_S, **kwargs)
    resp.raise_for_status()
    return resp.json()


def post_json(s: requests.Session, url: str, body: dict, **kwargs) -> dict:
    resp = s.post(url, json=body, timeout=DEFAULT_TIMEOUT_S, **kwargs)
    if resp.status_code >= 400:
        raise requests.HTTPError(f"{resp.status_code} from {url.split('?')[0]}: {resp.text[:500]}", response=resp)
    return resp.json()
