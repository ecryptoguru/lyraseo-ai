"""Generate signing-v1.json with Python's standard library and a public test key."""
import base64
import hashlib
import hmac
import json
import struct

work_id = "00000000-0000-4000-8000-000000000002"
ref = dict(workId=work_id, generation=1, claimToken="00000000-0000-4000-8000-000000000003")
cases = [
    ("dispatch", {"limit": 1}),
    ("dispatch/ack", ref),
    ("dispatch/defer", dict(ref, retrySeconds=3)),
    ("step", dict(version=1, workId=work_id, generation=1)),
    ("recover", {"limit": 1}),
]
vectors = []
for suffix, body in cases:
    path = "/api/internal/runtime/" + suffix
    raw = json.dumps(body, ensure_ascii=False, separators=(", ", ": "))
    digest = hashlib.sha256(raw.encode()).hexdigest()
    fields = [
        "lyra-runtime-v1", "test-2026", "lyraseo_dispatch", "lyraseo-kernel-a",
        "POST", path, "1800000000", "1800000060",
        "00000000-0000-4000-8000-000000000001", digest,
    ]
    encoded = [field.encode("utf-8") for field in fields]
    wire = b"".join(struct.pack(">I", len(field)) + field for field in encoded)
    signature = hmac.digest(bytes(range(32)), wire, "sha256")
    signature_text = base64.urlsafe_b64encode(signature).rstrip(b"=").decode()
    headers = {
        "x-lyra-key-id": fields[1], "x-lyra-principal": fields[2],
        "x-lyra-audience": fields[3], "x-lyra-issued-at": fields[6],
        "x-lyra-expires-at": fields[7], "x-lyra-request-id": fields[8],
        "x-lyra-signature": signature_text,
    }
    vectors.append(dict(
        path=path, raw=raw, sha=digest, canonicalHex=wire.hex(),
        signature=signature_text, headers=headers,
        lengths=[len(field) for field in encoded],
    ))
print(json.dumps(vectors, indent=2))
