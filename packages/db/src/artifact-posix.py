"""Single-operation LOCAL_TEST_ONLY backend. FD 3 is the verified root; FD 4 is a handshake."""
import contextlib
import hashlib
import json
import os
import re
import stat
import sys
import uuid

CAP = 5 * 1024 * 1024
DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
LEAF = os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
UUID = r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}"
OBJECT = re.compile(UUID + r"\." + UUID)
ROOT = 3


class Failure(Exception):
    pass


def require(ok):
    if not ok:
        raise Failure("INVALID_ARTIFACT")


@contextlib.contextmanager
def opened(parent, name, flags, mode=0o600):
    fd = os.open(name, flags, mode, dir_fd=parent)
    try:
        yield fd
    finally:
        os.close(fd)


def identity(info):
    return [str(info.st_dev), str(info.st_ino)]


def directory(fd):
    info = os.fstat(fd)
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o700)
    return identity(info)


def at(fd, name):
    return os.stat(name, dir_fd=fd, follow_symlinks=False)


def write_all(fd, data):
    view = memoryview(data)
    while view:
        n = os.write(fd, view[:65536])
        require(n > 0)
        view = view[n:]


def bootstrap(parts):
    # Start at the real filesystem root passed by Node and open each single component.
    require(os.path.samestat(os.fstat(ROOT), os.stat("/")))
    require(isinstance(parts, list) and 0 < len(parts) <= 128)
    with contextlib.ExitStack() as stack:
        fd = ROOT
        for part in parts:
            require(isinstance(part, str) and part not in ("", ".", "..") and "/" not in part and "\x00" not in part)
            fd = stack.enter_context(opened(fd, part, DIR))
        return directory(fd)


def pin_namespace(label, ns, stamp_exists):
    current = directory(ns)
    name = "." + label + ".identity"
    expected = (":".join(current) + "\n").encode("ascii")
    if not stamp_exists:
        try:
            with opened(ROOT, name, os.O_CREAT | os.O_EXCL | os.O_WRONLY | LEAF) as fd:
                write_all(fd, expected)
                os.fsync(fd)
            os.fsync(ROOT)
        except FileExistsError:
            pass
    with opened(ROOT, name, os.O_RDONLY | LEAF) as fd:
        st = os.fstat(fd)
        require(stat.S_ISREG(st.st_mode) and st.st_uid == os.geteuid() and st.st_nlink == 1 and stat.S_IMODE(st.st_mode) == 0o600)
        require(os.read(fd, 128) == expected)
    require(os.path.samestat(os.fstat(ns), at(ROOT, label)))


def check_leaf(info):
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and info.st_nlink == 1)


def tomb(info):
    return stat.S_IMODE(info.st_mode) == 0 and info.st_size == 0


def read_version(ns, name, size, digest, adopt=False):
    info = at(ns, name)
    check_leaf(info)
    if tomb(info):
        raise FileNotFoundError()
    mode = stat.S_IMODE(info.st_mode)
    require(mode in (0o400, 0o600))
    if mode == 0o400 and not adopt:
        raise FileNotFoundError()
    with opened(ns, name, os.O_RDONLY | LEAF) as fd:
        st = os.fstat(fd)
        check_leaf(st)
        require(os.path.samestat(st, info) and st.st_size == size)
        data = bytearray()
        while len(data) < size:
            part = os.read(fd, min(65536, size - len(data)))
            require(bool(part))
            data.extend(part)
        require(os.fstat(fd).st_size == size and hashlib.sha256(data).hexdigest() == digest)
        if mode == 0o400:
            os.fchmod(fd, 0o600)
            os.fsync(fd)
            os.fsync(ns)
        require(os.path.samestat(st, at(ns, name)))
        return bytes(data)


def withdraw(ns, name):
    try:
        st = at(ns, name)
        check_leaf(st)
        if tomb(st):
            os.fsync(ns)
            return
    except FileNotFoundError:
        pass
    marker = ".withdraw-" + str(uuid.uuid4())
    with opened(ns, marker, LEAF | os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0) as fd:
        try:
            os.fsync(fd)
            os.replace(marker, name, src_dir_fd=ns, dst_dir_fd=ns)
            os.fsync(ns)
        finally:
            try:
                os.unlink(marker, dir_fd=ns)
            except FileNotFoundError:
                pass


def put(ns, name, size, digest, data):
    require(len(data) == size and hashlib.sha256(data).hexdigest() == digest)
    try:
        fd = os.open(name, LEAF | os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o400, dir_fd=ns)
    except FileExistsError:
        read_version(ns, name, size, digest, True)
        return
    try:
        write_all(fd, data)
        os.fsync(fd)
        os.fchmod(fd, 0o600)
        os.fsync(fd)
        os.fsync(ns)
        require(os.path.samestat(os.fstat(fd), at(ns, name)))
    except BaseException:
        withdraw(ns, name)
        raise
    finally:
        os.close(fd)


def inventory(ns, after, limit):
    require(isinstance(limit, int) and 1 <= limit <= 100 and (after == "" or OBJECT.fullmatch(after)))
    names = []
    with opened(ns, ".", DIR) as listing, os.scandir(listing) as entries:
        for i, e in enumerate(entries):
            require(i < 50000)
            if e.name <= after or not OBJECT.fullmatch(e.name):
                continue
            try:
                info = at(ns, e.name)
            except FileNotFoundError:
                continue
            check_leaf(info)
            if stat.S_IMODE(info.st_mode) == 0o600:
                names.append(e.name)
                names.sort()
                del names[limit:]
    return json.dumps([dict(storageKey=n[:36], generation=n[37:]) for n in names]).encode()


def main():
    header = sys.stdin.buffer.readline(16385)
    require(len(header) <= 16384 and header.endswith(b"\n"))
    h = json.loads(header)
    op = h["op"]
    if op == "bootstrap":
        return json.dumps(bootstrap(h["parts"])).encode()
    require(op in ("put", "stat", "open", "recover", "delete", "inventory"))
    require(directory(ROOT) == h["root"])
    label = h["namespace"]
    require(re.fullmatch("[0-9a-f]{64}", label))
    try:
        at(ROOT, "." + label + ".identity")
        stamp_exists = True
    except FileNotFoundError:
        stamp_exists = False
    if op in ("put", "delete") and not stamp_exists:
        try:
            os.mkdir(label, 0o700, dir_fd=ROOT)
            os.fsync(ROOT)
        except FileExistsError:
            pass
    try:
        ns = os.open(label, DIR, dir_fd=ROOT)
    except FileNotFoundError:
        if not stamp_exists and op in ("inventory", "stat"):
            return b"[]" if op == "inventory" else b"false"
        raise
    try:
        pin_namespace(label, ns, stamp_exists)
        os.write(4, b"pinned\n")
        data = sys.stdin.buffer.read(CAP + 1)
        require(len(data) <= CAP and (op == "put" or not data))
        if op == "inventory":
            out = inventory(ns, h["after"], h["limit"])
        else:
            name, size, digest = h["name"], h["size"], h["digest"]
            require(OBJECT.fullmatch(name) and isinstance(size, int) and 0 <= size <= CAP and re.fullmatch("[0-9a-f]{64}", digest))
            out = b""
            if op == "put":
                put(ns, name, size, digest, data)
            elif op == "delete":
                withdraw(ns, name)
            elif op == "stat":
                try:
                    read_version(ns, name, size, digest)
                    out = b"true"
                except FileNotFoundError:
                    out = b"false"
            else:
                out = read_version(ns, name, size, digest, op == "recover")
        # This is an availability check. The pinned FD, not this check, confines all I/O.
        require(os.path.samestat(os.fstat(ns), at(ROOT, label)))
        return out
    finally:
        os.close(ns)


try:
    sys.stdout.buffer.write(main())
except (OSError, ValueError, KeyError, TypeError, Failure):
    sys.exit(1)  # Never transport path, bytes or OS diagnostics outside the helper.
