#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""wataamemo の PC 同期。

GitHub の非公開リポジトリ（pomera-data）の メモ-wataamemo/ と、
PC の C:\\Users\\<名前>\\OneDrive\\メモ-wataamemo をそろえる。
OneDrive に置いたファイルは OneDrive のアプリがクラウドへ上げるので、PC から見ても、
スマホ・タブレットの wataamemo から見ても、同じメモになる。

使い方（Windows）
  このファイルをダブルクリック（または  py wataamemo_sync.py ）
    → トークンを聞かれるので、pomenote / notes と同じもの（pomera-data に Contents: Read and write）を貼る
    → タスクスケジューラに「5分ごとに同期」を登録して、1回目の同期をする
  py wataamemo_sync.py --once       今すぐ1回だけ同期する（タスクが呼ぶのもこれ）
  py wataamemo_sync.py --status     設定と最後の同期の結果を見る
  py wataamemo_sync.py --uninstall  タスクを外す（ファイルとメモはそのまま）

決まり（wataamemo・ポメラタブと同じ考え方）
  - 1件1ファイル。.md と .txt だけを扱う（フォルダの中の画像などには触らない）
  - 前に同期したときの中身の印（git の blob sha）を覚えておき、どちらが変わったかで決める（3方向比較）
  - 両方で書き換えていたら、PC の版をそのまま送り、GitHub の版は「名前 (競合 GitHub版 日時).md」で残す
  - 消したら向こうでも消す。ただし向こうで書き換えられていたら消さずに戻す
  - 一覧が急に空・大半が消えて見えるとき、OneDrive のフォルダが見えないときは、何も消さずに止める
  - 標準ライブラリだけで動く（追加のインストールは要らない）
"""
import base64
import datetime
import getpass
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = os.environ.get('WATAAMEMO_API', 'https://api.github.com')
HOME = os.environ.get('LOCALAPPDATA') or os.path.join(os.path.expanduser('~'), '.local', 'share')
APP = os.path.join(HOME, 'wataamemo')
CONF = os.path.join(APP, 'config.json')
TOKEN = os.path.join(APP, 'token.txt')
STATE = os.path.join(APP, 'state.json')
LOG = os.path.join(APP, 'sync.log')
TASK = 'wataamemo-sync'
EXT = ('.md', '.txt')
ONEDRIVE = os.environ.get('OneDrive') or os.environ.get('OneDriveConsumer') or os.path.join(os.path.expanduser('~'), 'OneDrive')
DEFAULT = {
    'repo': 'aji-daze/pomera-data',
    'remote': 'メモ-wataamemo',
    'local': os.path.join(ONEDRIVE, 'メモ-wataamemo'),
    'branch': 'main',
}


class Stop(Exception):
    """同期をやめる（何も消さない）"""


# ---------------------------------------------------------------- 記録
def log(msg):
    os.makedirs(APP, exist_ok=True)
    line = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S') + '  ' + msg
    try:
        if os.path.exists(LOG) and os.path.getsize(LOG) > 300_000:
            with open(LOG, encoding='utf-8', errors='replace') as f:
                keep = f.readlines()[-500:]
            with open(LOG, 'w', encoding='utf-8') as f:
                f.writelines(keep)
        with open(LOG, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except OSError:
        pass
    if sys.stdout and sys.stdout.isatty():
        print(line)


def load(path, default):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def config():
    c = dict(DEFAULT)
    c.update(load(CONF, {}))
    return c


def token():
    try:
        with open(TOKEN, encoding='utf-8') as f:
            return f.read().strip()
    except OSError:
        return ''


# ---------------------------------------------------------------- GitHub
class GitHub:
    def __init__(self, conf, tok):
        self.repo, self.dir, self.branch, self.tok = conf['repo'], conf['remote'].strip('/'), conf['branch'], tok

    def call(self, method, path, body=None):
        url = API + '/repos/' + self.repo + path
        data = json.dumps(body).encode('utf-8') if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers={
            'Authorization': 'Bearer ' + self.tok,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'wataamemo-sync',
            'Content-Type': 'application/json',
        })
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            try:
                msg = json.loads(e.read()).get('message', '')
            except (ValueError, OSError):
                msg = ''
            err = RuntimeError('GitHub %d %s' % (e.code, msg))
            err.status = e.code
            raise err

    def path(self, name):
        return '/contents/' + urllib.parse.quote(self.dir + '/' + name)

    def repo_info(self):
        return self.call('GET', '')

    def list(self):
        try:
            r = self.call('GET', '/contents/' + urllib.parse.quote(self.dir) + '?ref=' + urllib.parse.quote(self.branch))
        except RuntimeError as e:
            if getattr(e, 'status', 0) == 404:
                self.repo_info()   # リポジトリ自体が見えないなら、ここで 404 のまま止まる（空と取り違えない）
                return {}
            raise
        return {x['name']: x['sha'] for x in (r if isinstance(r, list) else [])
                if x.get('type') == 'file' and x['name'].lower().endswith(EXT)}

    def read(self, sha):
        r = self.call('GET', '/git/blobs/' + sha)
        return base64.b64decode(r['content'])

    def put(self, name, data, sha=None):
        body = {'message': ('update: ' if sha else 'add: ') + self.dir + '/' + name + ' (pc)',
                'content': base64.b64encode(data).decode('ascii'), 'branch': self.branch}
        if sha:
            body['sha'] = sha
        return self.call('PUT', self.path(name), body)['content']['sha']

    def delete(self, name, sha):
        self.call('DELETE', self.path(name), {'message': 'delete: ' + self.dir + '/' + name + ' (pc)', 'sha': sha, 'branch': self.branch})


# ---------------------------------------------------------------- PC のフォルダ
def blob_sha(data):
    return hashlib.sha1(b'blob %d\0' % len(data) + data).hexdigest()


def local_files(folder):
    out = {}
    for name in os.listdir(folder):
        p = os.path.join(folder, name)
        if not os.path.isfile(p) or name.startswith(('.', '~$')) or not name.lower().endswith(EXT):
            continue
        with open(p, 'rb') as f:
            out[name] = blob_sha(f.read())
    return out


def write_local(folder, name, data):
    p = os.path.join(folder, name)
    tmp = os.path.join(folder, '.' + name + '.wataamemo-tmp')
    with open(tmp, 'wb') as f:
        f.write(data)
    os.replace(tmp, p)


def read_local(folder, name):
    with open(os.path.join(folder, name), 'rb') as f:
        return f.read()


def conflict_name(name, taken):
    stem, ext = os.path.splitext(name)
    base = '%s (競合 GitHub版 %s)' % (stem, datetime.datetime.now().strftime('%Y%m%d-%H%M'))
    cand, n = base + ext, 2
    while cand.lower() in taken:
        cand, n = '%s %d%s' % (base, n, ext), n + 1
    return cand


# ---------------------------------------------------------------- 同期本体
def sync_once(verbose=False):
    conf, tok = config(), token()
    if not tok:
        raise Stop('トークンがありません。このファイルをダブルクリックして設定してください')
    folder = conf['local']
    state = load(STATE, {})
    if not os.path.isdir(folder):
        if state:
            raise Stop('OneDrive のフォルダが見えません（%s）。OneDrive が止まっていないか確かめてください。何も消さずに止めました' % folder)
        os.makedirs(folder, exist_ok=True)

    gh = GitHub(conf, tok)
    remote = gh.list()
    local = local_files(folder)

    # 一覧が急に空・大半が消えて見えるときは、消されたと決めつけない
    if len(state) >= 5:
        for side, names in (('GitHub', remote), ('PC のフォルダ', local)):
            gone = sum(1 for n in state if n not in names)
            if gone * 2 >= len(state):
                raise Stop('%s の一覧が空、または大半が見えません（%d件中%d件）。何も消さずに止めました' % (side, len(state), gone))

    done = []

    def keep():
        save_json(STATE, state)

    taken = {n.lower() for n in list(remote) + list(local)}
    for name in sorted(set(remote) | set(local) | set(state)):
        R, L, B = remote.get(name), local.get(name), state.get(name)
        if R == L:
            if R:
                state[name] = R
            else:
                state.pop(name, None)
            continue
        if L == B:                     # PC は前のまま → GitHub の変更を写す
            if R is None:
                os.remove(os.path.join(folder, name))
                state.pop(name, None)
                done.append('PC から削除: ' + name)
            else:
                write_local(folder, name, gh.read(R))
                state[name] = R
                done.append('PC へ: ' + name)
        elif R == B:                   # GitHub は前のまま → PC の変更を送る
            if L is None:
                gh.delete(name, R)
                state.pop(name, None)
                done.append('GitHub から削除: ' + name)
            else:
                state[name] = gh.put(name, read_local(folder, name), R)
                done.append('GitHub へ: ' + name)
        elif L is None:                # PC で消したが GitHub で書き換えられていた → 消さずに戻す
            write_local(folder, name, gh.read(R))
            state[name] = R
            done.append('PC へ戻す（向こうで書き換えあり）: ' + name)
        elif R is None:                # GitHub で消されたが PC で書き換えていた → 送り直す
            state[name] = gh.put(name, read_local(folder, name))
            done.append('GitHub へ送り直す（PC で書き換えあり）: ' + name)
        else:                          # 両方で書き換えた → 両方残す
            other = conflict_name(name, taken)
            taken.add(other.lower())
            data = gh.read(R)
            write_local(folder, other, data)
            state[other] = gh.put(other, data)
            state[name] = gh.put(name, read_local(folder, name), R)
            done.append('競合（両方残す）: ' + name + ' / ' + other)
        keep()
    keep()
    log('同期 OK' + (': ' + '、'.join(done) if done else '（変更なし）'))
    return done


# ---------------------------------------------------------------- Windows のタスク
def pythonw():
    exe = sys.executable
    cand = os.path.join(os.path.dirname(exe), 'pythonw.exe')
    return cand if os.path.exists(cand) else exe


def install():
    print('wataamemo の PC 同期を設定します。\n')
    os.makedirs(APP, exist_ok=True)
    conf = config()

    print('同期する OneDrive のフォルダ（Enter でこのまま）:\n  ' + conf['local'])
    v = input('> ').strip().strip('"')
    if v:
        conf['local'] = v
    save_json(CONF, {k: conf[k] for k in DEFAULT})

    tok = token()
    while True:
        if not tok:
            print('\nGitHub のトークン（pomenote / notes で使っているもの。github_pat_…）を貼って Enter:')
            tok = getpass.getpass('> ').strip()
        try:
            info = GitHub(conf, tok).repo_info()
            if not info.get('private'):
                print('公開リポジトリです。メモが誰でも読めてしまうので使いません。')
                tok = ''
                continue
            break
        except RuntimeError as e:
            print('つながりません: %s' % e)
            tok = ''
    with open(TOKEN, 'w', encoding='utf-8') as f:
        f.write(tok)

    # 自分を決まった場所に写す（ダウンロードフォルダを片付けても動くように）
    dst = os.path.join(APP, 'wataamemo_sync.py')
    if os.path.abspath(__file__) != os.path.abspath(dst):
        shutil.copyfile(__file__, dst)

    if os.name == 'nt':
        cmd = '"%s" "%s" --once' % (pythonw(), dst)
        r = subprocess.run(['schtasks', '/Create', '/F', '/SC', 'MINUTE', '/MO', '5', '/TN', TASK, '/TR', cmd],
                           capture_output=True, text=True)
        if r.returncode != 0:
            print('タスクを登録できませんでした:\n' + (r.stderr or r.stdout))
        else:
            print('\nタスクスケジューラに「%s」（5分ごと）を登録しました。' % TASK)
    else:
        print('\n（Windows ではないので、自動実行の登録はしません。cron などで --once を呼んでください）')

    print('\n1回目の同期をします…')
    try:
        done = sync_once()
        print('できました。' + ('\n  ' + '\n  '.join(done) if done else '（変更なし）'))
    except (Stop, RuntimeError, OSError) as e:
        print('同期できませんでした: %s' % e)
    print('\n記録: ' + LOG)
    input('\nEnter で閉じる')


def uninstall():
    if os.name == 'nt':
        subprocess.run(['schtasks', '/Delete', '/F', '/TN', TASK])
    print('タスクを外しました。メモ（OneDrive のフォルダ・GitHub）と設定（%s）はそのままです。' % APP)


def status():
    conf = config()
    print('リポジトリ  : %s / %s' % (conf['repo'], conf['remote']))
    print('PC のフォルダ: %s%s' % (conf['local'], '' if os.path.isdir(conf['local']) else '（見つかりません）'))
    print('トークン    : %s' % ('あり' if token() else 'なし'))
    print('覚えている件数: %d' % len(load(STATE, {})))
    try:
        with open(LOG, encoding='utf-8') as f:
            print('最後の記録  : ' + f.readlines()[-1].rstrip())
    except (OSError, IndexError):
        print('最後の記録  : まだ')


def main(argv):
    if '--once' in argv:
        try:
            sync_once()
        except Stop as e:
            log('止めました: %s' % e)
            return 2
        except (RuntimeError, OSError, urllib.error.URLError) as e:
            log('同期できませんでした: %s' % e)   # 電波がないときなど。次の回にまた試す
            return 1
        return 0
    if '--status' in argv:
        status()
        return 0
    if '--uninstall' in argv:
        uninstall()
        return 0
    install()
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
