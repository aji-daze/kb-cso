# -*- coding: utf-8 -*-
"""
株式運用AI組織 分析エンジン（完全ローカル・トークン消費ゼロ）
旧trader_system(config.py/rules.py)のアラート基準を統合済み。
判断根拠は manual_rules.json（プロトレーダーマニュアル構造化版）を引用する。
"""
import json, math, os, random, urllib.request, xml.etree.ElementTree as ET
from datetime import datetime, date

BASE = os.path.dirname(os.path.abspath(__file__))
P = lambda *a: os.path.join(BASE, *a)

# ================= 設定（変更＝人間の決裁事項） =================
RISK_PCT_SWING = 0.010     # スイング1トレードリスク（R-01）
RISK_PCT_DAY   = 0.005     # 短期1トレードリスク（R-01）
ATR_STOP_K     = 2.0
MAX_POS_PCT    = 0.25
MIN_GRADE      = 50        # 推奨度C遮断（E-01）
MAX_POSITIONS  = 8         # R-04 上限
# 旧trader_system RULES 移植
AL = {
    "stop_loss_pct": -10.0,
    "stop_loss_overrides": {"285A.T": -12.0},
    "take_profit_pct": 25.0,
    "day_move_alert_pct": 4.0,
    "volume_spike_x": 2.0,
    "concentration_warn_pct": 25.0,
    "min_cash_pct": 10.0,
    "rsi_overbought": 70, "rsi_oversold": 30,
    "old_nisa_warn_days": 120,
}
NEWS_KEYWORDS = {
    "high": ["日銀", "利上げ", "FOMC", "利下げ", "為替介入", "急落", "暴落",
             "半導体", "NVIDIA", "エヌビディア", "キオクシア", "メモリ"],
    "mid":  ["円高", "円安", "決算", "ガイダンス", "CPI", "雇用統計", "DRAM", "NAND"],
}
NEWS_FEEDS = [
    ("Yahoo!経済", "https://news.yahoo.co.jp/rss/topics/business.xml"),
    ("NHK経済",   "https://www.nhk.or.jp/rss/news/cat5.xml"),
]
UNIVERSE = {
 "7203.T":"トヨタ自動車","6758.T":"ソニーG","8306.T":"三菱UFJ FG","9984.T":"ソフトバンクG",
 "6861.T":"キーエンス","8035.T":"東京エレクトロン","6501.T":"日立製作所","9432.T":"NTT",
 "9433.T":"KDDI","4063.T":"信越化学","6098.T":"リクルートHD","8058.T":"三菱商事",
 "8001.T":"伊藤忠商事","8031.T":"三井物産","7974.T":"任天堂","6902.T":"デンソー",
 "7267.T":"ホンダ","6367.T":"ダイキン工業","4519.T":"中外製薬","4568.T":"第一三共",
 "4502.T":"武田薬品","6273.T":"SMC","6954.T":"ファナック","7741.T":"HOYA",
 "8766.T":"東京海上HD","8316.T":"三井住友FG","8411.T":"みずほFG","2914.T":"JT",
 "3382.T":"セブン&アイHD","9983.T":"ファーストリテイリング","4661.T":"OLC","6594.T":"ニデック",
 "6981.T":"村田製作所","6752.T":"パナソニックHD","5401.T":"日本製鉄","9101.T":"日本郵船",
 "8802.T":"三菱地所","1605.T":"INPEX","9613.T":"NTTデータG","4901.T":"富士フイルム",
 "6503.T":"三菱電機","7011.T":"三菱重工業","6146.T":"ディスコ","6857.T":"アドバンテスト",
}
INDICES = {"^N225":"日経平均","USDJPY=X":"ドル円","^GSPC":"S&P500","^SOX":"SOX指数"}
SEMI_KEYS = ("半導体", "キオクシア", "ディスコ", "アドバンテスト", "エレクトロン", "ケミコン")

# ================= 汎用 =================
def f(x, nd=2):
    try:
        v = float(x)
        return None if math.isnan(v) or math.isinf(v) else round(v, nd)
    except (TypeError, ValueError):
        return None

def tick(p):
    if p is None: return None
    if p >= 10000: return round(p / 10) * 10
    if p >= 5000:  return round(p / 5) * 5
    return round(p)

def jload(path, default):
    try:
        with open(path, encoding="utf-8") as fp: return json.load(fp)
    except Exception:
        return default

def jsave(path, obj):
    with open(path, "w", encoding="utf-8") as fp:
        json.dump(obj, fp, ensure_ascii=False, indent=1)

def load_portfolio(): return jload(P("portfolio.json"), {"cash": 0, "holdings": {}, "candidates": {}, "nisa": {}})

def load_analyses():
    """dashboard/analysis/{ticker}.json … Claude等が生成した精密分析を読み込む"""
    out, d = {}, P("analysis")
    if os.path.isdir(d):
        for fn in os.listdir(d):
            if fn.endswith(".json"):
                a = jload(os.path.join(d, fn), None)
                if a and a.get("ticker"):
                    try:
                        a["age_days"] = (date.today() - date.fromisoformat(str(a.get("analyzed_at", ""))[:10])).days
                    except Exception:
                        a["age_days"] = None
                    out[a["ticker"]] = a
    return out
def load_briefing():
    """dashboard/briefings/{YYYY-MM-DD}.json … briefing-auditor が監査した朝の日報。最新1件を返す"""
    d = P("briefings")
    if not os.path.isdir(d): return None
    fs = sorted(fn for fn in os.listdir(d) if fn.endswith(".json"))
    b = jload(os.path.join(d, fs[-1]), None) if fs else None
    if b:
        try:
            b["age_days"] = (date.today() - date.fromisoformat(str(b.get("date", ""))[:10])).days
        except Exception:
            b["age_days"] = None
    # inbox.md（人間が貼った原文）が監査JSONより新しければ「未監査」フラグ
    inbox = os.path.join(d, "inbox.md")
    if os.path.isfile(inbox):
        raw_m = os.path.getmtime(inbox)
        aud_m = os.path.getmtime(os.path.join(d, fs[-1])) if fs else 0
        if raw_m > aud_m:
            if b is None: b = {}
            b["pending_raw"] = True
    return b
def save_portfolio(pf): jsave(P("portfolio.json"), pf)
def load_manual(): return jload(P("manual_rules.json"), {"meta": {}, "rules": []})
MANUAL = load_manual()
RULE = {r["id"]: r for r in MANUAL.get("rules", [])}
def cite(*ids): return [{"id": i, "rule": RULE[i]["rule"]} for i in ids if i in RULE]

# ================= データ取得 =================
def demo_history(tk, start_price):
    rnd = random.Random(hash(tk) & 0xffff)
    n, p = 260, float(start_price)
    closes, highs, lows, vols = [], [], [], []
    drift = rnd.uniform(-0.0005, 0.0012)
    for _ in range(n):
        p = max(p * (1 + rnd.gauss(drift, 0.018)), 10)
        closes.append(p); highs.append(p * (1 + abs(rnd.gauss(0, .008))))
        lows.append(p * (1 - abs(rnd.gauss(0, .008)))); vols.append(max(rnd.lognormvariate(12, .5), 1000))
    return {"close": closes, "high": highs, "low": lows, "vol": vols}

def fetch_all(tickers, holdings, demo):
    out = {}
    if demo:
        for tk in tickers:
            base = holdings.get(tk, {}).get("cost", random.Random(hash(tk)).uniform(800, 6000))
            out[tk] = demo_history(tk, base)
        return out
    import yfinance as yf
    df = yf.download(list(tickers), period="1y", interval="1d",
                     group_by="ticker", auto_adjust=True, progress=False, threads=True)
    for tk in tickers:
        try:
            sub = df[tk].dropna(how="all") if len(tickers) > 1 else df.dropna(how="all")
            if len(sub) < 5: continue
            out[tk] = {"close": sub["Close"].tolist(), "high": sub["High"].tolist(),
                       "low": sub["Low"].tolist(), "vol": sub["Volume"].fillna(0).tolist()}
        except Exception as e:
            print(f"[warn] {tk}: {e}")
    return out

# ================= 指標 =================
def sma(a, n): return sum(a[-n:]) / n if len(a) >= n else None

def rsi14(c):
    if len(c) < 15: return None
    g = l = 0.0
    for i in range(-14, 0):
        d = c[i] - c[i - 1]
        g, l = (g + d, l) if d >= 0 else (g, l - d)
    return 100.0 if l == 0 else 100 - 100 / (1 + g / l)

def atr14(h, l, c):
    if len(c) < 15: return None
    return sum(max(h[i]-l[i], abs(h[i]-c[i-1]), abs(l[i]-c[i-1])) for i in range(-14, 0)) / 14

def indicators(d):
    c, h, l, v = d["close"], d["high"], d["low"], d["vol"]
    px = c[-1]
    ma25, ma75 = sma(c, 25), sma(c, 75)
    hi52, lo52 = max(c), min(c)
    i = {"price": px, "day_pct": (px/c[-2]-1)*100 if len(c) > 1 else 0,
         "w1_pct": (px/c[-6]-1)*100 if len(c) > 6 else None,
         "m1_pct": (px/c[-21]-1)*100 if len(c) > 21 else None,
         "ma25": ma25, "ma75": ma75, "rsi": rsi14(c), "atr": atr14(h, l, c),
         "hi60": max(c[-60:]), "lo60": min(c[-60:]), "hi52": hi52, "lo52": lo52,
         "pos52": (px-lo52)/(hi52-lo52)*100 if hi52 > lo52 else 50,
         "vol_ratio": (sma(v,5)/sma(v,25)) if sma(v,25) else None,
         "vol_spike": (v[-1]/sma(v,20)) if sma(v,20) else None,
         "spark": [round(x,1) for x in c[-60:]]}
    i["ma25_dev"] = (px/ma25-1)*100 if ma25 else None
    if ma25 and ma75:
        i["trend"] = "上昇" if px > ma25 > ma75 else ("下降" if px < ma25 < ma75 else "中立")
    else:
        i["trend"] = "中立" if not ma25 else ("上昇" if px > ma25 else "下降")
    i["off_high"] = (px/i["hi60"]-1)*100
    return i

# ================= 保有診断 =================
def days_to(datestr):
    try: return (date.fromisoformat(datestr) - date.today()).days
    except Exception: return None

def analyze_holding(tk, info, i):
    px, cost, qty = i["price"], info["cost"], info["qty"]
    pl_pct = (px/cost-1)*100
    stop = tick(px - ATR_STOP_K * i["atr"]) if i["atr"] else None
    stop_rule = AL["stop_loss_overrides"].get(tk, AL["stop_loss_pct"])
    rsi, dev = i["rsi"] or 50, i["ma25_dev"] or 0
    if pl_pct <= stop_rule:
        level, action = "danger", "損切りライン到達（X-01）"
    elif pl_pct <= stop_rule + 3:
        level, action = "warn", "損切りライン接近"
    elif i["trend"] == "下降" and rsi < 40:
        level, action = "warn", "要注意（下降トレンド）"
    elif pl_pct >= AL["take_profit_pct"] or rsi >= AL["rsi_overbought"]:
        level, action = "info", "一部利確検討（X-03）"
    elif i["trend"] == "上昇" and abs(dev) <= 1.5:
        level, action = "buy", "押し目買い増し候補"
    else:
        level, action = "ok", "継続保有"
    sell_by = info.get("sell_by")
    dleft = days_to(sell_by) if sell_by else None
    return {"ticker": tk, "name": info["name"], "qty": qty, "cost": cost,
            "account": info.get("account", "特定"), "sell_by": sell_by, "days_left": dleft,
            "price": f(px), "day_pct": f(i["day_pct"]), "value": f(px*qty, 0),
            "pl": f((px-cost)*qty, 0), "pl_pct": f(pl_pct, 1),
            "rsi": f(i["rsi"],1), "ma25_dev": f(i["ma25_dev"],1), "trend": i["trend"],
            "atr": f(i["atr"],1), "stop": stop, "stop_rule_pct": stop_rule,
            "vol_ratio": f(i["vol_ratio"],2), "vol_spike": f(i["vol_spike"],2),
            "w1_pct": f(i["w1_pct"],1), "m1_pct": f(i["m1_pct"],1), "pos52": f(i["pos52"],0),
            "action": action, "level": level, "spark": i["spark"],
            "facts": f"RSI {f(rsi,1)}｜25日線乖離 {f(dev,1)}%｜トレンド{i['trend']}｜52週レンジ位置 {f(i['pos52'],0)}%"}

# ================= 候補 + プラン =================
def nisa_fit(name):
    if "ETF" in name or "高配当" in name:
        return "◎ 長期向き・NISA成長枠に最適（分配/分散型）"
    if any(k in name for k in SEMI_KEYS):
        return "△ 高ボラ・短期回転なら特定口座も検討（NISAは損切りで枠消費・損益通算不可）"
    return "○ NISA可（中期以上の保有前提なら）"

def score_candidate(i):
    rsi, dev = i["rsi"] or 50, i["ma25_dev"] if i["ma25_dev"] is not None else 99
    off, vr = i["off_high"] if i["off_high"] is not None else 0, i["vol_ratio"] or 1
    up = i["trend"] == "上昇" or (i["ma75"] and i["price"] > i["ma75"])
    s1, r1 = 0, []
    if up: s1 += 25; r1.append("中期トレンド上向き（75日線上）")
    if abs(dev) <= 2.0: s1 += 25; r1.append(f"25日線タッチ圏（乖離{f(dev,1)}%）")
    if -15 <= off <= -4: s1 += 20; r1.append(f"直近高値から{f(-off,1)}%の押し")
    if 35 <= rsi <= 55: s1 += 20; r1.append(f"RSI {f(rsi,1)}（過熱なし）")
    if vr >= 1.0: s1 += 10; r1.append(f"出来高維持（比{f(vr,2)}倍）")
    s2, r2 = 0, []
    if off >= -1.0: s2 += 35; r2.append("60日高値圏（ブレイク目前/更新）")
    if vr >= 1.5: s2 += 30; r2.append(f"出来高急増（比{f(vr,2)}倍）")
    elif vr >= 1.2: s2 += 15; r2.append(f"出来高増加（比{f(vr,2)}倍）")
    if up: s2 += 20; r2.append("トレンド上向き")
    if 50 <= rsi <= 70: s2 += 15; r2.append(f"RSI {f(rsi,1)}（順行域）")
    return (s1, "押し目買い", r1) if s1 >= s2 else (s2, "ブレイクアウト", r2)

def build_plan(name, strat, i, capital):
    """E-03 3分割・X-03 2R部分利確・X-04 時間撤退 に基づく売買プラン"""
    atr = i["atr"] or i["price"] * 0.02
    is_etf = "ETF" in name or "高配当" in name
    if strat == "押し目買い" and i["ma25"]:
        entries = [tick(i["ma25"]), tick(i["ma25"] - 0.5*atr), tick(i["ma25"] - atr)]
    else:
        entries = [tick(i["hi60"] * 1.005), tick(i["hi60"] * 0.99)]
    avg = sum(entries) / len(entries)
    stop = tick(avg - ATR_STOP_K * atr)
    r = max(avg - stop, 1)
    t1, t2 = tick(avg + 2*r), tick(avg + 3*r)
    period = ("長期（6ヶ月〜）押し目分割で積む" if is_etf
              else "中期スイング（2〜8週）" if strat == "押し目買い" else "短期（1〜4週）")
    risk_pct = RISK_PCT_SWING if strat == "押し目買い" or is_etf else RISK_PCT_DAY
    lot = int(capital * risk_pct / r / 100) * 100
    while lot > 0 and lot * avg > capital * MAX_POS_PCT:
        lot -= 100
    return {"period": period, "entries": entries, "entry_avg": tick(avg),
            "stop": stop, "target1": t1, "target2": t2,
            "target1_note": "2R到達で1/3〜1/2利確・残りは損切りを建値へ（X-02/X-03）",
            "lot": lot, "risk_amt": f(lot * r, 0) if lot else 0, "risk_pct": risk_pct * 100,
            "review": "20営業日で目標未達なら時間撤退・再評価（X-04）。エントリー根拠が崩れたら即撤退（X-05）",
            "nisa": nisa_fit(name),
            "rule_ids": ["E-02", "E-03", "E-04", "R-05", "X-03", "X-04"]}

def build_candidate(tk, name, i, source, capital):
    score, strat, rationale = score_candidate(i)
    return {"ticker": tk, "name": name, "source": source, "strategy": strat,
            "score": score, "grade": "S" if score >= 85 else "A" if score >= 70 else "B" if score >= MIN_GRADE else "C",
            "price": f(i["price"]), "day_pct": f(i["day_pct"]), "rsi": f(i["rsi"],1),
            "trend": i["trend"], "off_high": f(i["off_high"],1), "vol_ratio": f(i["vol_ratio"],2),
            "pos52": f(i["pos52"],0), "rationale": rationale, "spark": i["spark"],
            "plan": build_plan(name, strat, i, capital)}

# ================= アラート（旧rules.py統合） =================
def scan_alerts(hold_rows, market, news, cash_pct, conc_name, conc_pct):
    out, now = [], datetime.now().strftime("%m/%d %H:%M")
    def add(level, key, text, tk=""):
        out.append({"ts": now, "level": level, "key": f"{date.today()}_{key}", "text": text, "ticker": tk})
    for h in hold_rows:
        nm, tk = h["name"], h["ticker"]
        if h["day_pct"] is not None and abs(h["day_pct"]) >= AL["day_move_alert_pct"]:
            add("danger" if h["day_pct"] < 0 else "good", f"{tk}_move", f"{nm} 前日比{h['day_pct']:+.1f}%の急変", tk)
        if h["vol_spike"] and h["vol_spike"] >= AL["volume_spike_x"]:
            add("warn", f"{tk}_vol", f"{nm} 出来高急増（20日平均の{h['vol_spike']:.1f}倍）→材料・転換に注意", tk)
        if h["level"] == "danger":
            add("danger", f"{tk}_stop", f"🛑 {nm} 損切りライン到達 {h['pl_pct']:+.1f}%（基準{h['stop_rule_pct']}%）→撤退検討【X-01】", tk)
        elif h["pl_pct"] is not None and h["pl_pct"] <= h["stop_rule_pct"] + 3:
            add("warn", f"{tk}_stopnear", f"{nm} 損切りライン接近 {h['pl_pct']:+.1f}%", tk)
        if h["pl_pct"] is not None and h["pl_pct"] >= AL["take_profit_pct"]:
            add("good", f"{tk}_tp", f"💰 {nm} 含み益{h['pl_pct']:+.1f}% → 2R部分利確・建値トレール検討【X-02/X-03】", tk)
        if h["rsi"] and h["rsi"] >= AL["rsi_overbought"]:
            add("warn", f"{tk}_rsiH", f"{nm} RSI {h['rsi']} 買われすぎ圏", tk)
        elif h["rsi"] and h["rsi"] <= AL["rsi_oversold"]:
            add("info", f"{tk}_rsiL", f"{nm} RSI {h['rsi']} 売られすぎ圏", tk)
        if h["days_left"] is not None and h["days_left"] <= AL["old_nisa_warn_days"]:
            add("warn", f"{tk}_nisa", f"⏳ {nm} 旧NISA期限まで{h['days_left']}日（{h['sell_by']}）売却/払出し計画を", tk)
    if conc_pct >= AL["concentration_warn_pct"]:
        add("warn", "conc", f"⚠️ 集中リスク: {conc_name}がポートの{conc_pct:.0f}%（基準{AL['concentration_warn_pct']}%）")
    if cash_pct < AL["min_cash_pct"]:
        add("warn", "cash", f"現金比率{cash_pct:.1f}%が下限（{AL['min_cash_pct']}%）割れ")
    for n in news:
        lv = "danger" if any(k in n["title"] for k in NEWS_KEYWORDS["high"]) else \
             "warn" if any(k in n["title"] for k in NEWS_KEYWORDS["mid"]) else None
        if lv: add(lv, f"news_{hash(n['title'])&0xffff}", f"📰 {n['title'][:52]}")
    return out

def merge_alerts(new):
    hist = jload(P("alerts.json"), [])
    seen = {a["key"] for a in hist}
    hist = [a for a in new if a["key"] not in seen] + hist
    hist = hist[:200]
    jsave(P("alerts.json"), hist)
    return hist

# ================= 取引記録・成績（J-01〜J-05） =================
def trade_stats(trades, capital):
    done = [t for t in trades if t.get("pl") is not None]
    if not done:
        return {"n": 0, "win_rate": None, "pf": None, "avg_r": None, "compliance": None, "total_pl": 0}
    wins = [t["pl"] for t in done if t["pl"] > 0]
    losses = [abs(t["pl"]) for t in done if t["pl"] < 0]
    rs = [t["pl"] / t["risk"] for t in done if t.get("risk")]
    comp = [t for t in done if t.get("rule_ok") is not None]
    return {"n": len(done),
            "win_rate": f(len(wins)/len(done)*100, 1),
            "pf": f(sum(wins)/sum(losses), 2) if losses else None,
            "avg_r": f(sum(rs)/len(rs), 2) if rs else None,
            "compliance": f(sum(1 for t in comp if t["rule_ok"])/len(comp)*100, 0) if comp else None,
            "total_pl": round(sum(t["pl"] for t in done))}

# ================= ニュース =================
def name_key(name):
    for s in ("HD", "GHD", "FG", " ", "・"): name = name.replace(s, "")
    return name[:5] if len(name) >= 3 else name

def fetch_news(watch_names, demo):
    if demo:
        return [{"title": "（デモ）日銀、政策金利を据え置き 円は小動き", "link": "#", "source": "デモ", "time": "08:00", "tickers": []}]
    items = []
    for src, url in NEWS_FEEDS:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=10) as r:
                root = ET.fromstring(r.read())
            for it in root.iter("item"):
                title = (it.findtext("title") or "").strip()
                if not title: continue
                hits = [n for n, key in watch_names if key and key in title]
                items.append({"title": title, "link": it.findtext("link") or "#",
                              "source": src, "time": (it.findtext("pubDate") or "")[:22], "tickers": hits})
        except Exception as e:
            print(f"[warn] news {src}: {e}")
    items.sort(key=lambda x: len(x["tickers"]), reverse=True)
    return items[:14]

# ================= 相談エンジン（統括プロトレーダー） =================
def _ind_of(state, tk):
    for h in state["holdings"]:
        if h["ticker"] == tk: return ("h", h)
    for c in state["candidates"]:
        if c["ticker"] == tk: return ("c", c)
    return (None, None)

def _esc_prompt(state, q, focus_lines, rule_ids):
    pf = state["portfolio"]
    rules = "\n".join(f"- {RULE[i]['id']}: {RULE[i]['rule']}（{RULE[i].get('value','')}）" for i in rule_ids if i in RULE)
    holds = "\n".join(f"- {h['name']}({h['ticker']}) {h['qty']}株@{h['cost']} 現値{h['price']} 損益{h['pl_pct']}% {h['account']} RSI{h['rsi']} {h['trend']}" for h in state["holdings"])
    return f"""【役割】あなたは日本株の統括プロトレーダー。事実と数値のみで助言し、最終判断は私（人間）が行う。
【運用ルール（遵守前提・変更不可）】
{rules}
【ポートフォリオ】評価額{pf['total_value']:,}円 / 含み損益{pf['total_pl']:+,}円({pf['pl_pct']}%) / 現金{state['cash']:,}円{'('+state.get('cash_note','')+')' if state.get('cash_note') else ''} / NISA成長枠残 {state['nisa'].get('growth_remaining',0):,}円
{holds}
【対象データ】
{focus_lines}
【質問】{q.get('note') or q.get('topic_label','')}
【出力形式】結論1行 → 根拠3点（数値必須）→ 具体的な価格・数量 → リスクと撤退条件。推測は「推測」と明記。"""

def consult(state, q):
    """q: {scope, ticker, topic, horizon, note}"""
    topic = q.get("topic", "hoshin")
    tk = q.get("ticker", "")
    horizon = q.get("horizon", "mid")
    HL = {"short": "短期（〜4週）", "mid": "中期（1〜6ヶ月）", "long": "長期（6ヶ月〜）"}
    kind, obj = _ind_of(state, tk) if tk else (None, None)
    if tk and obj is None:
        return {"title": "銘柄が見つかりません", "verdict": f"{tk} は現在の保有・候補リストにありません",
                "points": ["「銘柄・資金の管理」から候補に追加すると次回更新後に相談可能になります"],
                "levels": [], "citations": [], "prompt": "", "disclaimer": ""}
    pf, cash, nisa = state["portfolio"], state["cash"], state["nisa"]
    capital = pf["total_value"] + cash
    points, levels, rule_ids, verdict = [], [], [], ""
    title = ""

    if topic == "sashine" and obj:
        title = f"{obj['name']} 指値プラン（{HL[horizon]}）"
        plan = obj.get("plan")
        if not plan:
            i = {"atr": obj.get("atr"), "price": obj.get("price"), "ma25": None, "hi60": obj.get("price"), "ma25_dev": obj.get("ma25_dev")}
            atr = obj.get("atr") or obj["price"] * 0.02
            e = [tick(obj["price"] - 0.3*atr), tick(obj["price"] - 0.8*atr), tick(obj["price"] - 1.3*atr)]
            avg = sum(e)/3; stop = tick(avg - 2*atr); r = avg - stop
            plan = {"entries": e, "entry_avg": tick(avg), "stop": stop,
                    "target1": tick(avg+2*r), "target2": tick(avg+3*r),
                    "lot": int(capital*RISK_PCT_SWING/max(r,1)/100)*100, "risk_amt": None, "period": HL[horizon]}
        verdict = f"3分割指値・平均{plan['entry_avg']}円、損切り{plan['stop']}円、目標{plan['target1']}→{plan['target2']}円"
        points = [f"分割指値（E-03）: {' / '.join(str(e)+'円' for e in plan['entries'])}（時間・価格分散）",
                  f"損切り{plan['stop']}円は発注と同時に逆指値で（E-04）。成行は使わない（E-02）",
                  f"ロット{plan['lot']}株 = 資金×リスク{f(RISK_PCT_SWING*100,1)}% ÷ (指値−損切り)（R-05）",
                  f"2R（{plan['target1']}円）で1/3〜1/2利確し損切りを建値へ移動（X-02/X-03）"]
        levels = [{"label": "分割指値", "value": " / ".join(f"{e:,}円" for e in plan["entries"])},
                  {"label": "損切り", "value": f"{plan['stop']:,}円"},
                  {"label": "目標① / ②", "value": f"{plan['target1']:,} / {plan['target2']:,}円"},
                  {"label": "ロット", "value": f"{plan['lot']}株"}]
        rule_ids = ["E-02", "E-03", "E-04", "R-05", "X-02", "X-03"]

    elif topic == "hoshin" and obj:
        title = f"{obj['name']} {HL[horizon]}方針"
        trend, rsi = obj["trend"], obj.get("rsi") or 50
        pos52 = obj.get("pos52")
        if horizon == "short":
            verdict = "順張り可（押し目待ち）" if trend == "上昇" and rsi < AL["rsi_overbought"] else \
                      "過熱・新規は見送り" if rsi >= AL["rsi_overbought"] else \
                      "戻り売り警戒・手出し無用" if trend == "下降" else "レンジ・様子見"
        elif horizon == "mid":
            verdict = "保有/押し目買い方針" if trend != "下降" else "反転確認まで待機"
        else:
            verdict = ("52週レンジ上位・強い" if (pos52 or 50) >= 60 else "52週レンジ下位・仕込み域の可能性（要ファンダ確認）")
        points = [f"トレンド: {trend}（25日/75日線基準）、RSI {rsi}",
                  f"52週レンジ位置 {pos52}%・直近高値乖離 {obj.get('off_high') or obj.get('ma25_dev')}%",
                  "セットアップ全条件が揃うまで新規は入れない（E-01）",
                  f"{HL[horizon]}では{'時間撤退20営業日を目安に再評価（X-04）' if horizon!='long' else '四半期ごとに戦略層レビュー（C-02）'}"]
        if kind == "h" and obj.get("account") == "旧NISA":
            points.append(f"⏳ 旧NISA期限 {obj['sell_by']}（残り{obj['days_left']}日）。長期継続なら払出し/売却の決裁が必要")
        rule_ids = ["E-01", "X-04", "C-02"]

    elif topic == "rieki" and kind == "h":
        title = f"{obj['name']} 利確・損切り判断"
        pl, atr, px = obj["pl_pct"] or 0, obj.get("atr") or 1, obj["price"]
        r2 = obj["cost"] + 2 * (ATR_STOP_K * atr)
        if pl <= obj["stop_rule_pct"]:
            verdict = "損切りライン到達 → 即執行（裁量介入禁止）"
            rule_ids = ["X-01", "F-02"]
        elif px >= r2:
            verdict = f"2R相当到達 → 1/3〜1/2部分利確・残りは損切りを建値{tick(obj['cost'])}円へ"
            rule_ids = ["X-02", "X-03"]
        elif pl >= AL["take_profit_pct"]:
            verdict = "含み益25%超 → 部分利確を検討（利益の早期確保とトレンド追随の両立）"
            rule_ids = ["X-03"]
        else:
            verdict = f"保有継続。参考損切り{obj['stop']}円（-2ATR）を下回ったら機械的に執行"
            rule_ids = ["X-01"]
        points = [f"損益 {pl:+.1f}%（{obj['pl']:+,}円）、現値{px}円 / 取得{obj['cost']}円",
                  f"参考2Rライン: {tick(r2):,}円 / 参考損切り: {obj['stop']:,}円",
                  "シナリオ破綻（根拠否定）なら含み益でも撤退（X-05）"]
        if obj.get("account") == "旧NISA":
            points.append(f"旧NISA期限{obj['sell_by']}まで残り{obj['days_left']}日 → 利確は期限内なら非課税で完結")
        levels = [{"label": "現値/取得", "value": f"{px:,} / {obj['cost']:,}円"},
                  {"label": "参考損切り", "value": f"{obj['stop']:,}円"},
                  {"label": "2Rライン", "value": f"{tick(r2):,}円"}]

    elif topic == "kaimashi" and kind == "h":
        title = f"{obj['name']} 買い増し判断"
        if (obj["pl_pct"] or 0) < 0:
            verdict = "不可 — 含み損銘柄への買い増しはナンピン（F-01違反）"
            points = ["平均取得単価を下げる買い増しはマニュアルで禁止事項",
                      "反転を確認し、独立した新規セットアップとして成立してから検討",
                      f"現在 {obj['pl_pct']}%。まず損切りライン{obj['stop']:,}円の遵守を優先"]
            rule_ids = ["F-01", "X-01"]
        elif obj["trend"] == "上昇" and abs(obj.get("ma25_dev") or 9) <= 2:
            atr = obj.get("atr") or obj["price"]*0.02
            e1 = tick(obj["price"] - 0.3*atr)
            lot = int(capital*RISK_PCT_DAY/max(2*atr,1)/100)*100
            verdict = f"条件成立 — 押し目{e1:,}円で小口買い増し可（リスク0.5%以内）"
            points = [f"上昇トレンド+25日線タッチ圏（乖離{obj['ma25_dev']}%）で押し目の型",
                      f"追加分の損切りは{tick(e1-2*atr):,}円、追加ロット目安{lot}株",
                      "買い増し後も1銘柄比率25%以内を維持（集中リスク）"]
            rule_ids = ["E-03", "R-01", "R-04"]
        else:
            verdict = "見送り — 押し目の型が未成立"
            points = [f"トレンド{obj['trend']}・25日線乖離{obj['ma25_dev']}%。タッチ圏(±2%)まで待つ",
                      "セットアップ全条件成立が前提（E-01）"]
            rule_ids = ["E-01"]

    elif topic == "nisa":
        title = "NISA枠の活用相談"
        rem = nisa.get("growth_remaining", 0)
        olds = [h for h in state["holdings"] if h.get("account") == "旧NISA"]
        verdict = f"成長投資枠 残り{rem:,}円。長期・分散型から優先充当を"
        points = [f"旧NISA保有: " + ("、".join(f"{h['name']}（期限{h['sell_by']}・残{h['days_left']}日）" for h in olds) if olds else "なし"),
                  "NISAは損失の損益通算・繰越不可 → 損切り前提の短期回転は特定口座、腰を据える中長期をNISAに",
                  "候補のNISA適性: " + "、".join(f"{c['name']}={c['plan']['nisa'][:1]}" for c in state["candidates"][:6]),
                  f"枠内で組める例: 候補上位のETF系を{rem//2:,}円分・個別を残りで分割買い（E-03）"]
        levels = [{"label": "成長枠 残り", "value": f"{rem:,}円"},
                  {"label": "旧NISA期限", "value": olds[0]["sell_by"] if olds else "-"}]
        rule_ids = ["R-06", "E-03"]

    else:  # shindan / portfolio全般
        title = "ポートフォリオ診断（統括トレーダー総括）"
        st = state["trades_stats"]
        conc = state["risk"]["concentration_pct"]
        points = [f"評価額{pf['total_value']:,}円+現金{cash:,}円{'（'+state.get('cash_note','')+'）' if state.get('cash_note') else ''} / 含み損益{pf['total_pl']:+,}円（{pf['pl_pct']}%）",
                  f"建玉{pf['positions']}銘柄（上限{MAX_POSITIONS}・R-04）→ {'上限到達。新規は入替前提' if pf['positions']>=MAX_POSITIONS else '余裕あり'}",
                  f"最大集中 {state['risk']['concentration_name']} {conc:.0f}%（基準25%）/ 現金比率{state['risk']['cash_pct']:.1f}%",
                  f"全損切り時想定損失 {state['risk']['worst_loss']:,}円（月次予算-6%={int(capital*0.06):,}円と比較・R-03）",
                  (f"成績: {st['n']}取引 勝率{st['win_rate']}% PF{st['pf']} 平均R{st['avg_r']}（目標: 勝率50%/PF1.5/R0.5・J-02/J-03）" if st["n"] else "取引記録なし。約定したら必ず記録（J-01/P-02）")]
        verdict = "健全" if conc < 25 and state["risk"]["cash_pct"] >= 10 else "要調整（集中/現金比率）"
        rule_ids = ["R-04", "R-03", "J-02", "J-03", "J-01"]

    q["topic_label"] = title
    focus = ""
    if obj:
        focus = f"{obj['name']}({tk}) 現値{obj['price']} RSI{obj.get('rsi')} トレンド{obj['trend']} ATR{obj.get('atr')} 52週位置{obj.get('pos52')}%"
    prompt = _esc_prompt(state, q, focus, rule_ids)
    return {"title": title, "verdict": verdict, "points": points, "levels": levels,
            "citations": cite(*rule_ids), "prompt": prompt,
            "disclaimer": "ルールベースの機械的算定です。決算・材料など定性判断が絡む場合は「Claudeに深掘り」を使用してください。投資助言ではありません。"}

# ================= メイン更新 =================
def pct_s(m): return f"{m['day_pct']:+.1f}%" if m and m.get("day_pct") is not None else "-"
def val_s(m): return f"{m['price']:.1f}" if m and m.get("price") is not None else "-"

def update(demo=False):
    pf_cfg = load_portfolio()
    holdings, manual_cands = pf_cfg["holdings"], pf_cfg["candidates"]
    cash, nisa = pf_cfg.get("cash", 0), pf_cfg.get("nisa", {})
    cash_note = pf_cfg.get("cash_note", "")
    tickers = set(holdings) | set(manual_cands) | set(UNIVERSE)
    hist = fetch_all(tickers, holdings, demo)
    idx_hist = fetch_all(INDICES.keys(), {}, demo)

    market = []
    for tk, nm in INDICES.items():
        if tk not in idx_hist: continue
        i = indicators(idx_hist[tk])
        market.append({"ticker": tk, "name": nm, "price": f(i["price"]), "day_pct": f(i["day_pct"]),
                       "w1_pct": f(i["w1_pct"],1), "trend": i["trend"], "spark": i["spark"]})

    hold_rows = [analyze_holding(tk, info, indicators(hist[tk]))
                 for tk, info in holdings.items() if tk in hist]
    total_v = sum(h["value"] or 0 for h in hold_rows)
    total_c = sum(h["cost"]*h["qty"] for h in hold_rows)
    capital = total_v + cash
    day_chg = sum((h["value"] or 0)*(h["day_pct"] or 0)/100 for h in hold_rows)

    manual_list, screened = [], []
    for tk, info in manual_cands.items():
        if tk in holdings or tk not in hist: continue
        manual_list.append(build_candidate(tk, info["name"], indicators(hist[tk]), "手動リスト", capital))
    held = set(holdings) | set(manual_cands)
    for tk, nm in UNIVERSE.items():
        if tk in held or tk not in hist: continue
        c = build_candidate(tk, nm, indicators(hist[tk]), "AIスクリーニング", capital)
        if c["grade"] == "C": continue
        # 執行可能性フィルタ: 現金で1単元も買えない・ロット0株の銘柄は候補に上げない（絵に描いた餅の排除）
        unit_cost = (c["plan"]["entry_avg"] or 0) * 100
        if c["plan"]["lot"] <= 0 or unit_cost > cash:
            continue
        screened.append(c)
    screened.sort(key=lambda x: x["score"], reverse=True)
    # 手動リストは常に残す。スクリーニング分は枠の残りを上位から（最低6件）
    cands = manual_list + screened[:max(6, 12 - len(manual_list))]
    cands.sort(key=lambda x: x["score"], reverse=True)
    # 精密分析（Claude生成・analysis/*.json）を候補に添付
    analyses = load_analyses()
    for c in cands:
        if c["ticker"] in analyses:
            c["deep"] = analyses[c["ticker"]]

    watch = [(h["name"], name_key(h["name"])) for h in hold_rows] + [(c["name"], name_key(c["name"])) for c in cands]
    news = fetch_news(watch, demo)

    # リスク集計
    max_pos = max(hold_rows, key=lambda h: h["value"] or 0) if hold_rows else None
    conc = (max_pos["value"]/total_v*100) if (max_pos and total_v) else 0
    cash_pct = cash/capital*100 if capital else 0
    worst_loss = round(sum((h["price"]-(h["stop"] or h["price"]))*h["qty"] for h in hold_rows))
    risk = {"concentration_name": max_pos["name"] if max_pos else "-", "concentration_pct": conc,
            "cash_pct": cash_pct, "worst_loss": worst_loss,
            "daily_budget": int(capital*0.02), "monthly_budget": int(capital*0.06)}

    alerts = merge_alerts(scan_alerts(hold_rows, market, news, cash_pct, risk["concentration_name"], conc)) if True else []

    # 取引記録
    trades = jload(P("trades.json"), [])
    tstats = trade_stats(trades, capital)

    # 提案（稟議）
    today = date.today().isoformat()
    proposals = []
    for h in hold_rows:
        if h["level"] in ("danger", "warn", "info", "buy"):
            t = {"danger": "売り", "warn": "監視強化", "info": "利確", "buy": "買い増し"}[h["level"]]
            proposals.append({"id": f"{today}_{h['ticker']}_{t}", "kind": t, "level": h["level"],
                              "ticker": h["ticker"], "name": h["name"],
                              "title": f"{h['name']}：{h['action']}",
                              "detail": f"現値{h['price']}円（損益{h['pl_pct']}%）。{h['facts']}。参考損切り {h['stop']}円。"})
    for c in cands:
        if c["grade"] in ("S", "A") and c["plan"]["lot"]:
            p = c["plan"]
            proposals.append({"id": f"{today}_{c['ticker']}_新規", "kind": "新規買い", "level": "buy",
                              "ticker": c["ticker"], "name": c["name"],
                              "title": f"{c['name']}：{c['strategy']}（推奨度{c['grade']}・{p['period']}）",
                              "detail": f"分割指値 {'/'.join(str(e) for e in p['entries'])}円、損切り{p['stop']}円、目標{p['target1']}→{p['target2']}円、{p['lot']}株（リスク{p['risk_amt']:,.0f}円）。{p['nisa']}"})

    # 資産推移
    jpath = P("journal.json")
    journal = [j for j in jload(jpath, []) if j["date"] != today]
    journal.append({"date": today, "value": round(total_v + cash), "pl": round(total_v - total_c)})
    journal.sort(key=lambda x: x["date"])
    if not demo: jsave(jpath, journal)

    # 統括トレーダー総括
    n225 = next((m for m in market if m["ticker"] == "^N225"), None)
    spx = next((m for m in market if m["ticker"] == "^GSPC"), None)
    fx = next((m for m in market if m["ticker"] == "USDJPY=X"), None)
    macro_score = sum(1 for m in (n225, spx) if m and (m["day_pct"] or 0) > 0)
    bias = ["弱気（守り優先・新規縮小）", "中立（選別対応）", "強気（順張り許可）"][macro_score]
    danger_n = sum(1 for h in hold_rows if h["level"] == "danger")
    top_c = cands[0] if cands else None
    head_summary = {
        "bias": bias,
        "text": (f"地合いは{bias.split('（')[0]}。" +
                 (f"最優先: 損切り検討{danger_n}件の決裁。" if danger_n else "") +
                 (f"新規は{top_c['name']}（{top_c['strategy']}・推奨度{top_c['grade']}）が筆頭。" if top_c and top_c['grade'] in 'SA' else "新規は妙味薄、待機も戦略。") +
                 f"建玉{len(hold_rows)}/{MAX_POSITIONS}・現金比率{cash_pct:.0f}%・月次リスク予算{risk['monthly_budget']:,}円。" +
                 "AIはあくまで提案まで。採否の判断と執行はあなたのみが行う。"),
        "checklist": ["提案ボックスで採用/見送りを判断", "採用分のみ証券会社で指値発注（成行禁止・E-02）",
                      "約定したら取引記録に入力（J-01）", "アラート発生時のみ画面確認でOK"]}

    warn_n = sum(1 for h in hold_rows if h["level"] in ("danger", "warn"))
    hot_n = sum(1 for h in hold_rows if (h["rsi"] or 0) >= 70)
    up_n = sum(1 for h in hold_rows if h["trend"] == "上昇")
    best = max(hold_rows, key=lambda h: h["pl_pct"] or -99) if hold_rows else None
    worst = min(hold_rows, key=lambda h: h["pl_pct"] or 99) if hold_rows else None
    staff = [
        {"id": "head", "icon": "🎖", "name": "head_trader", "role": "統括プロトレーダー", "badge": "稼働中", "level": "ok",
         "kpis": [{"l": "バイアス", "v": bias[:2]}, {"l": "提案", "v": f"{len(proposals)}"}, {"l": "建玉", "v": f"{len(hold_rows)}/{MAX_POSITIONS}"}],
         "today": "総括判断・相談デスク応対・マニュアル整合チェック",
         "scope": "全AI社員の統括。相談デスクで短中長期・指値・NISAの定型相談に即答（ルールベース）",
         "note": "定型外の深掘りはエスカレーション用プロンプトを発行して人間がClaudeへ", "next": "毎更新時に総括を再生成"},
        {"id": "macro", "icon": "🌐", "name": "macro_strategist", "role": "マクロ戦略担当", "badge": "稼働中", "level": "ok",
         "kpis": [{"l": "日経", "v": pct_s(n225)}, {"l": "S&P500", "v": pct_s(spx)}, {"l": "ドル円", "v": val_s(fx)}],
         "today": f"地合い判定 → 本日のバイアス: {bias}", "scope": "指数・為替・地合い判定。個別売買の判断はしない",
         "note": f"日経{pct_s(n225)}・S&P{pct_s(spx)}・ドル円{val_s(fx)}", "next": "翌営業日の寄り前に再判定"},
        {"id": "analyst", "icon": "📊", "name": "equity_analyst", "role": "保有銘柄アナリスト",
         "badge": "警戒" if warn_n else "稼働中", "level": "warn" if warn_n else "ok",
         "kpis": [{"l": "監視", "v": f"{len(hold_rows)}"}, {"l": "要注意", "v": f"{warn_n}"}, {"l": "上昇T", "v": f"{up_n}"}],
         "today": f"保有{len(hold_rows)}銘柄診断・要注意{warn_n}件を提案として提出",
         "scope": "保有銘柄の日次診断・アクション提案（実行権限なし）",
         "note": (f"最良 {best['name']} {best['pl_pct']:+.1f}% / 最悪 {worst['name']} {worst['pl_pct']:+.1f}%" if best and worst else "-"),
         "next": "終値ベースで再診断"},
        {"id": "screener", "icon": "🔎", "name": "screener", "role": "候補発掘担当", "badge": "稼働中", "level": "ok",
         "kpis": [{"l": "母集団", "v": f"{len(UNIVERSE)}"}, {"l": "通過", "v": f"{len(cands)}"}, {"l": "最高", "v": (top_c["grade"] if top_c else "-")}],
         "today": (f"筆頭候補 {top_c['name']}（{top_c['strategy']}・{top_c['score']}点）" if top_c else "基準通過なし"),
         "scope": "スクリーニング・採点・分割指値/損切り/目標/期間プラン算出",
         "note": f"推奨度C（{MIN_GRADE}点未満）は提案に上げず遮断（E-01）", "next": "毎更新時に再スクリーニング"},
        {"id": "risk", "icon": "🛡", "name": "risk_manager", "role": "リスク管理担当",
         "badge": "警戒" if conc > 25 or danger_n else "稼働中", "level": "warn" if conc > 25 or danger_n else "ok",
         "kpis": [{"l": "全損切時", "v": f"-{worst_loss/10000:,.1f}万"}, {"l": "最大集中", "v": f"{conc:.0f}%"}, {"l": "現金", "v": f"{cash_pct:.0f}%"}],
         "today": f"想定最大損失{worst_loss:,}円（月次予算{risk['monthly_budget']:,}円・R-03）を監視",
         "scope": "損切り線・集中度・現金比率・リスク予算の遵守チェック",
         "note": (f"最大ポジション {max_pos['name']} {conc:.0f}%" + ("。25%超過・追加買い非推奨" if conc > 25 else "") if max_pos else "-"),
         "next": "損切り線接近で即アラート"},
        {"id": "journal", "icon": "📔", "name": "journal_keeper", "role": "記録・決裁管理担当", "badge": "稼働中", "level": "ok",
         "kpis": [{"l": "判断待ち", "v": f"{len(proposals)}"}, {"l": "記録", "v": f"{len(journal)}日"}, {"l": "取引", "v": f"{tstats['n']}件"}],
         "today": f"提案{len(proposals)}件を提案ボックスに登録・資産推移記録・成績集計（勝率{tstats['win_rate'] or '-'}%）",
         "scope": "資産推移・決裁ログ・取引ジャーナル・成績統計（J-01〜J-05）",
         "note": "ジャーナル未入力の約定があれば入力完了まで新規エントリー禁止（P-02）", "next": "週次サマリー材料を蓄積"},
    ]

    data = {"generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "demo": demo,
            "capital": capital, "cash": cash, "cash_note": cash_note, "nisa": nisa,
            "risk_rule": f"1トレード{RISK_PCT_DAY*100:.1f}〜{RISK_PCT_SWING*100:.1f}% / 損切り-{ATR_STOP_K}ATR / 建玉上限{MAX_POSITIONS}",
            "portfolio": {"total_value": round(total_v), "total_cost": round(total_c),
                          "total_pl": round(total_v-total_c),
                          "pl_pct": f((total_v/total_c-1)*100, 2) if total_c else 0,
                          "day_change": round(day_chg), "positions": len(hold_rows)},
            "risk": risk, "market": market, "holdings": hold_rows, "candidates": cands,
            "staff": staff, "head": head_summary, "news": news, "proposals": proposals,
            "equity": journal, "alerts": alerts[:60], "trades": trades[-30:][::-1], "trades_stats": tstats,
            "briefing": load_briefing(), "manual": MANUAL}
    with open(P("data.js"), "w", encoding="utf-8") as fp:
        fp.write("window.DASHBOARD_DATA = ")
        json.dump(data, fp, ensure_ascii=False)
        fp.write(";")
    return data

if __name__ == "__main__":
    import sys
    d = update("--demo" in sys.argv)
    print(f"更新完了: 保有{len(d['holdings'])} 候補{len(d['candidates'])} 稟議{len(d['proposals'])} アラート{len(d['alerts'])}")
