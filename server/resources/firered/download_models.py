"""Download fixed official assets; validate before extracting. Standard library only."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tarfile
import urllib.request

MANIFEST = json.loads(Path(__file__).with_name("models.json").read_text(encoding="utf-8"))


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as file:
        for block in iter(lambda: file.read(8 * 1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def valid(path, asset):
    return path.is_file() and path.stat().st_size == asset["bytes"] and digest(path) == asset["sha256"]


def download(directory, asset, source=None):
    path = directory / asset["name"]
    if valid(path, asset):
        return path
    if source and valid(source / asset["name"], asset):
        shutil.copyfile(source / asset["name"], path)
        return path
    partial = path.with_name(path.name + ".part")
    size = partial.stat().st_size if partial.exists() else 0
    if size >= asset["bytes"]:
        partial.unlink()
        size = 0
    request = urllib.request.Request(MANIFEST["baseUrl"] + asset["name"],
                                    headers={"Range": f"bytes={size}-"} if size else {})
    print(f"正在下载 {asset['name']}（支持续传）...", flush=True)
    with urllib.request.urlopen(request, timeout=60) as response:
        append = size and response.status == 206
        if append and not response.headers.get("Content-Range", "").startswith(f"bytes {size}-"):
            raise ValueError("下载续传位置不一致，请重新运行安装")
        with partial.open("ab" if append else "wb") as file:
            while True:
                block = response.read(1024 * 1024)
                if not block:
                    break
                file.write(block)
                if file.tell() > asset["bytes"]:
                    raise ValueError("下载文件超过固定资产大小")
    if not valid(partial, asset):
        partial.unlink(missing_ok=True)
        raise ValueError("模型 SHA-256 校验失败，请检查网络后重新安装")
    partial.replace(path)
    return path


def extract(archive, target):
    # Never extract links, devices, test audio, or paths outside the expected model directory.
    expected = archive.name.removesuffix(".tar.bz2")
    with tarfile.open(archive, "r:bz2") as file:
        for member in file:
            relative = Path(member.name)
            if relative.is_absolute() or ".." in relative.parts or not relative.parts or relative.parts[0] != expected:
                raise ValueError("模型压缩包包含无效路径")
            if member.isdir():
                continue
            if not member.isfile():
                raise ValueError("模型压缩包包含非普通文件")
            if "test_wavs" in relative.parts:
                continue
            destination = target / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.is_symlink() or any(parent.is_symlink() for parent in destination.parents):
                raise ValueError("模型目录不能包含符号链接")
            with file.extractfile(member) as source, destination.open("wb") as output:
                shutil.copyfileobj(source, output)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-cache", type=Path, required=True)
    parser.add_argument("--source-cache", type=Path)
    args = parser.parse_args()
    target = args.model_cache.resolve()
    target.mkdir(parents=True, exist_ok=True)
    lock = target / ".install.lock"
    descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    try:
        (target / "installed.json").unlink(missing_ok=True)
        archives = target / "downloads"
        archives.mkdir(exist_ok=True)
        for asset in MANIFEST["assets"]:
            path = download(archives, asset, args.source_cache)
            if path.name.endswith(".tar.bz2"):
                print("正在校验并解压模型...", flush=True)
                extract(path, target)
            else:
                shutil.copyfile(path, target / path.name)
        files = [target / MANIFEST["aed"] / name for name in ("encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt")]
        files += [target / MANIFEST["ctc"] / name for name in ("model.int8.onnx", "tokens.txt")]
        files += [target / "silero_vad.onnx"]
        proof = {"version": MANIFEST["version"], "files": [
            {"path": str(path.relative_to(target)), "bytes": path.stat().st_size, "sha256": digest(path)} for path in files]}
        (target / "installed.json").write_text(json.dumps(proof, indent=2), encoding="utf-8")
        print("FireRed 识别模型与字词对齐模型已安装并通过校验。", flush=True)
    finally:
        os.close(descriptor)
        lock.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
