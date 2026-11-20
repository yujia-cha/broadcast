import hashlib
import io
import json
import urllib.error

import pytest

from jeongsi.updater import (
    ASSET_NAME,
    ReleaseInfo,
    UpdateError,
    Updater,
    apply_update,
    cleanup_old_exe,
    is_newer,
    old_exe_path,
    parse_version,
)

EXE = b"new exe bytes" * 100
BASE = "https://github.com/yujia-cha/broadcast/releases/download/v1.2.0/"


class Resp(io.BytesIO):
    def __init__(self, data: bytes):
        super().__init__(data)
        self.headers = {"Content-Length": str(len(data))}


def release_json(tag="v1.2.0", **extra):
    data = {
        "tag_name": tag,
        "body": "· 수정 사항",
        "published_at": "2026-11-18T00:00:00Z",
        "html_url": "https://github.com/yujia-cha/broadcast/releases/tag/" + tag,
        "assets": [
            {"name": ASSET_NAME, "browser_download_url": BASE + ASSET_NAME},
            {"name": ASSET_NAME + ".sha256", "browser_download_url": BASE + ASSET_NAME + ".sha256"},
        ],
    }
    data.update(extra)
    return json.dumps(data).encode()


def opener(routes):
    def _open(url, timeout=15.0):
        value = routes[url]
        if isinstance(value, Exception):
            raise value
        return Resp(value)

    return _open


API = "https://api.github.com/repos/yujia-cha/broadcast/releases/latest"


@pytest.mark.parametrize(
    "candidate,current,expected",
    [
        ("v1.2.0", "1.1.0", True),
        ("v1.10.0", "1.9.0", True),  # 문자열 비교가 아니라 숫자 비교
        ("v1.2", "1.2.0", False),
        ("v1.1.0", "1.2.0", False),
        ("v1.3.0-beta", "1.2.0", False),  # 사전 릴리즈 제외
        ("garbage", "1.0.0", False),
    ],
)
def test_is_newer(candidate, current, expected):
    assert is_newer(candidate, current) is expected


def test_parse_version_rejects_negative_and_empty():
    assert parse_version("") is None
    assert parse_version("v1.-1") is None


def test_check_returns_release_when_newer():
    # Arrange
    updater = Updater("1.1.0", opener=opener({API: release_json()}))
    # Act
    release = updater.check()
    # Assert
    assert release.version == "1.2.0"
    assert updater.status()["state"] == "available"


def test_check_returns_none_when_same_version():
    updater = Updater("1.2.0", opener=opener({API: release_json()}))
    assert updater.check() is None
    assert updater.status()["state"] == "latest"


def test_check_ignores_release_without_checksum():
    data = json.loads(release_json())
    data["assets"] = data["assets"][:1]
    updater = Updater("1.0.0", opener=opener({API: json.dumps(data).encode()}))
    assert updater.check() is None


def test_check_ignores_assets_hosted_elsewhere():
    data = json.loads(release_json())
    data["assets"][0]["browser_download_url"] = "https://evil.example/x.exe"
    updater = Updater("1.0.0", opener=opener({API: json.dumps(data).encode()}))
    assert updater.check() is None


def test_check_404_means_no_release_yet():
    err = urllib.error.HTTPError(API, 404, "Not Found", {}, None)
    updater = Updater("1.0.0", opener=opener({API: err}))
    assert updater.check() is None


def test_check_offline_raises_update_error():
    updater = Updater("1.0.0", opener=opener({API: OSError("offline")}))
    with pytest.raises(UpdateError):
        updater.check()
    assert updater.status()["state"] == "error"


def _release():
    return ReleaseInfo("1.2.0", "", "", "", BASE + ASSET_NAME, BASE + ASSET_NAME + ".sha256")


def test_download_verifies_checksum(tmp_path):
    good = hashlib.sha256(EXE).hexdigest().encode() + b"  " + ASSET_NAME.encode()
    updater = Updater("1.0.0", opener=opener({BASE + ASSET_NAME: EXE, BASE + ASSET_NAME + ".sha256": good}))
    path = updater.download(_release(), tmp_path)
    assert path.read_bytes() == EXE
    assert updater.status()["state"] == "ready"


def test_download_with_wrong_checksum_removes_file(tmp_path):
    bad = b"0" * 64
    updater = Updater("1.0.0", opener=opener({BASE + ASSET_NAME: EXE, BASE + ASSET_NAME + ".sha256": bad}))
    with pytest.raises(UpdateError, match="손상"):
        updater.download(_release(), tmp_path)
    assert list(tmp_path.iterdir()) == []


def test_download_rejects_malformed_checksum_file(tmp_path):
    updater = Updater("1.0.0", opener=opener({BASE + ASSET_NAME: EXE, BASE + ASSET_NAME + ".sha256": b"nope"}))
    with pytest.raises(UpdateError, match="형식"):
        updater.download(_release(), tmp_path)


def test_apply_update_swaps_files_and_launches(tmp_path):
    # Arrange
    exe = tmp_path / ASSET_NAME
    exe.write_bytes(b"old")
    new = tmp_path / "new.exe"
    new.write_bytes(b"new")
    launched = []
    # Act
    apply_update(new, exe, launch=launched.append)
    # Assert
    assert exe.read_bytes() == b"new"
    assert old_exe_path(exe).read_bytes() == b"old"
    assert launched == [[str(exe), "--updated"]]
    cleanup_old_exe(exe)
    assert not old_exe_path(exe).exists()


def test_apply_update_rolls_back_when_new_file_missing(tmp_path):
    exe = tmp_path / ASSET_NAME
    exe.write_bytes(b"old")
    with pytest.raises(UpdateError):
        apply_update(tmp_path / "missing.exe", exe, launch=lambda args: None)
    assert exe.read_bytes() == b"old"


def test_mark_error_sets_state_and_message():
    updater = Updater("1.0.0", opener=opener({}))
    updater.mark_error("쓸 수 없음")
    assert updater.status() == {"state": "error", "message": "쓸 수 없음", "current": "1.0.0"}


def test_local_feed_is_used_and_allows_local_downloads():
    feed = "http://127.0.0.1:9999/latest.json"
    data = json.loads(release_json())
    for asset in data["assets"]:
        asset["browser_download_url"] = "http://127.0.0.1:9999/" + asset["name"]
    updater = Updater("1.0.0", opener=opener({feed: json.dumps(data).encode()}), feed_url=feed)
    assert updater.check().asset_url == "http://127.0.0.1:9999/" + ASSET_NAME


def test_feed_override_rejects_remote_hosts():
    with pytest.raises(ValueError):
        Updater("1.0.0", feed_url="https://evil.example/latest.json")


def test_apply_update_passes_extra_args(tmp_path):
    exe = tmp_path / ASSET_NAME
    exe.write_bytes(b"old")
    new = tmp_path / "new.exe"
    new.write_bytes(b"new")
    launched = []
    apply_update(new, exe, launch=launched.append, extra_args=["--port", "5000"])
    assert launched == [[str(exe), "--port", "5000", "--updated"]]


def test_cleanup_old_exe_gives_up_quietly(tmp_path, monkeypatch):
    exe = tmp_path / ASSET_NAME
    old = old_exe_path(exe)
    old.write_bytes(b"old")
    calls = []

    def locked(self, missing_ok=False):
        calls.append(1)
        raise PermissionError("잠김")

    monkeypatch.setattr(type(old), "unlink", locked)
    cleanup_old_exe(exe, attempts=3, delay=0)
    assert len(calls) == 3
