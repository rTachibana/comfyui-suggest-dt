import json
import os
import threading
import urllib.parse
import urllib.request

import aiohttp
from aiohttp import web
from server import PromptServer

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
WEB_DIRECTORY = "js"

NODE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(NODE_DIR, "data")
TAGS_FILE = os.path.join(DATA_DIR, "danbooru.csv")
CONFIG_FILE = os.path.join(DATA_DIR, "file-sources.json")

# a1111-sd-webui-tagcomplete's danbooru.csv: tag,category,count,"aliases"
TAGS_URL = (
    "https://raw.githubusercontent.com/DominikDoom/"
    "a1111-sd-webui-tagcomplete/main/tags/danbooru.csv"
)


def _download_tags():
    os.makedirs(DATA_DIR, exist_ok=True)
    if os.path.exists(TAGS_FILE):
        print("[suggest-dt] Tags cache found, skipping download.")
        return
    print("[suggest-dt] Downloading danbooru.csv ...")
    try:
        urllib.request.urlretrieve(TAGS_URL, TAGS_FILE)
        with open(TAGS_FILE, encoding="utf-8") as f:
            count = sum(1 for _ in f)
        print(f"[suggest-dt] Tags loaded: {count} entries")
    except Exception as e:
        print(f"[suggest-dt] Failed to download tags: {e}")


threading.Thread(target=_download_tags, daemon=True).start()


def _load_config():
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, encoding="utf-8") as f:
            return json.load(f)
    return {"sources": []}


# ── Tag data ──────────────────────────────────────────────────────────────────

@PromptServer.instance.routes.get("/suggest-dt/tags")
async def get_tags(request):
    if not os.path.exists(TAGS_FILE):
        return web.Response(status=404, text="Tags not yet downloaded.")
    return web.FileResponse(TAGS_FILE)


# ── Wiki proxy (avoids CORS) ──────────────────────────────────────────────────

@PromptServer.instance.routes.get("/suggest-dt/wiki")
async def get_wiki(request):
    tag = request.query.get("tag", "").strip()
    if not tag:
        return web.Response(status=400, text="Missing tag parameter.")
    url = f"https://danbooru.donmai.us/wiki_pages/{urllib.parse.quote(tag)}.json"
    try:
        timeout = aiohttp.ClientTimeout(total=6)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url) as resp:
                if resp.status == 404:
                    return web.Response(status=404)
                if resp.status != 200:
                    return web.Response(status=resp.status)
                data = await resp.json(content_type=None)
                return web.json_response({"body": data.get("body", "")})
    except Exception as e:
        return web.Response(status=500, text=str(e))


# ── File sources ──────────────────────────────────────────────────────────────

@PromptServer.instance.routes.get("/suggest-dt/config")
async def get_config(request):
    return web.json_response(_load_config())


@PromptServer.instance.routes.post("/suggest-dt/config")
async def save_config(request):
    data = await request.json()
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return web.Response(status=200)


@PromptServer.instance.routes.get("/suggest-dt/files")
async def list_files(request):
    config = _load_config()
    result = []
    for source in config.get("sources", []):
        folder = source.get("folder", "").strip()
        prefix = source.get("prefix", "")
        suffix = source.get("suffix", "")
        if not folder or not os.path.isdir(folder):
            continue
        for name in _wildcard_names(folder):
            result.append({"name": name, "prefix": prefix, "suffix": suffix})
    return web.json_response(result)


def _structured_names(data, prefix):
    """Key paths of the lists in a YAML/JSON wildcard file (sd-dynamic-prompts naming)."""
    if isinstance(data, list):
        return [prefix] if prefix and data else []
    names = []
    if isinstance(data, dict):
        for key, value in data.items():
            names += _structured_names(value, f"{prefix}/{key}" if prefix else str(key))
    return names


def _wildcard_names(folder):
    """
    Wildcard names under *folder*, including subfolders (``dir/name``).
    A ``.txt`` file is named by its path; a YAML/JSON file holding a mapping
    gives one name per list inside, by folder plus key path (the file name is
    not part of it): ``clothing.yaml`` → ``clothing: {tops: […]}`` → ``clothing/tops``.
    """
    names = set()
    for root, dirs, files in os.walk(folder):
        dirs.sort()
        rel_dir = os.path.relpath(root, folder).replace("\\", "/")
        rel_dir = "" if rel_dir == "." else rel_dir
        for fname in files:
            stem, ext = os.path.splitext(fname)
            ext = ext.lower()
            if ext not in (".txt", ".yaml", ".yml", ".json"):
                continue
            rel = f"{rel_dir}/{stem}" if rel_dir else stem
            if ext == ".txt":
                names.add(rel)
                continue
            try:
                with open(os.path.join(root, fname), encoding="utf-8") as f:
                    if ext == ".json":
                        data = json.load(f)
                    else:
                        import yaml
                        data = yaml.safe_load(f)
            except Exception:
                continue  # unreadable or malformed: leave it out
            if isinstance(data, list):
                names.add(rel)
            else:
                names.update(_structured_names(data, rel_dir))
    return sorted(names, key=str.lower)
