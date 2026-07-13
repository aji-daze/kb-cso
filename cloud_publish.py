# -*- coding: utf-8 -*-
"""クラウド版データ発行: engine.update() を実行し、スマホ用に暗号化した
docs/data.enc.json を生成する（GitHub Actions から呼ばれる）。
必要な環境変数: DATA_PIN（閲覧用暗証番号。GitHub Secretsに設定）
"""
import base64, hashlib, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import engine  # noqa: E402

from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: E402


def main():
    pin = os.environ.get("DATA_PIN", "")
    if not pin:
        raise SystemExit("環境変数 DATA_PIN が未設定です（GitHub Secretsに追加してください）")

    d = engine.update(False)

    # スマホ版に必要な項目だけ抜粋（軽量化）
    payload = {
        "generated_at": d.get("generated_at"),
        "risk_rule": d.get("risk_rule"),
        "cash": d.get("cash"),
        "cash_note": d.get("cash_note"),
        "nisa": d.get("nisa"),
        "portfolio": d.get("portfolio"),
        "market": d.get("market"),
        "holdings": d.get("holdings"),
        "candidates": d.get("candidates"),
        "alerts": (d.get("alerts") or [])[:20],
        "head": d.get("head"),
    }

    raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    salt, nonce = os.urandom(16), os.urandom(12)
    key = hashlib.pbkdf2_hmac("sha256", pin.encode("utf-8"), salt, 200_000, dklen=32)
    ct = AESGCM(key).encrypt(nonce, raw, None)

    out = {
        "v": 1,
        "salt": base64.b64encode(salt).decode(),
        "nonce": base64.b64encode(nonce).decode(),
        "data": base64.b64encode(ct).decode(),
        "generated_at": payload["generated_at"],  # 平文は日時のみ
    }
    os.makedirs("docs", exist_ok=True)
    with open(os.path.join("docs", "data.enc.json"), "w", encoding="utf-8") as fp:
        json.dump(out, fp)
    print("発行完了:", payload["generated_at"],
          f"保有{len(payload['holdings'])} 候補{len(payload['candidates'])}")


if __name__ == "__main__":
    main()
