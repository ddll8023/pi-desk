#!/usr/bin/env python3
"""用户级全局日记、画像与月度摘要的 SQLite 存储引擎，不依赖当前项目或项目登记。

权威数据只有一份：`<store>/memory.db`（WAL）。记录、画像、月摘要、访问统计与待确认计划同库同事务，
词项作为派生数据与记录在同一事务内写入，读取不再核对原文指纹。检索保持词法（CJK 双字片段 + BM25）
与既有打分口径，只把候选裁剪交给库内词项表。

旧 Markdown 库只经 `migrate` 一次性导入；运行期不读也不写 Markdown，`export` 仅生成只读快照。
检索默认覆盖全库，可按注册表项目收窄；时间上默认分层召回：近窗口查日记，更早月份优先用月摘要代表。
"""
import argparse, contextlib, datetime as dt, hashlib, json, math, re, secrets, sqlite3, sys, time, unicodedata, uuid
from collections import Counter
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
import zoneinfo

DB_NAME = 'memory.db'
# PRAGMA user_version 是唯一版本源；库内不再保留第二份可写版本号。
STORE_VERSION = 1
READABLE_VERSION = STORE_VERSION
PLAN_VERSION = 4
TYPES = {'decision','constraint','progress','issue','fact','preference_evidence'}
RULE_TYPES = {'decision','constraint'}
# 非规则类记录只用于「项目近况」，不参与常驻约定的族收敛与替代。
NOTE_TYPES = TYPES - RULE_TYPES
DOMAINS = {'communication','coding','learning','workflow'}
ID_RE = re.compile(r'^[msp]_[0-9A-HJKMNP-TV-Z]{26}$')
# 项目归属取桌面项目注册表的 UUID；旧项目段里的自由命名只作历史来源，不参与匹配。
PROJECT_ID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
DEFAULT_RECENT_WINDOW = 30
SEARCH_ALGORITHM = 'cjk-bigram-bm25-v1'
SEARCH_TOKENS = re.compile(r'[a-z0-9_]+|[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\U00020000-\U0002ebef]+')
SEARCH_STOPWORDS = {'的','了','是','在','和','与','我','你','如何','什么','怎么','一个','这个','那个',
                    'the','a','an','and','or','is','are','to','of','for','in','how','what'}
BUSY_TIMEOUT_SECONDS = 10.0
BUSY_RETRIES = 4
ACCESS_NOTE = '仅统计采集开始后的主动定向读取；不代表全部访问、模型接收、理解、采纳或事实正确，不参与检索排序。'
BACKGROUND_POLICY = 'lexical-global-background-v3'
BACKGROUND_STOPWORDS = {'当前','现在','需要','可以','已经','相关','问题','项目','功能','优化','处理',
                       '继续','一下','看看','进行','是否','推荐','建议','方案','实现','本次','以下',
                       'please','could','would','should','help','with','this','that'}
# 自动背景的类型权重：决定与约束优先于进展流水，避免历史流水挤占有限的背景预算。
TYPE_WEIGHT = {'decision':1.6,'constraint':1.8,'preference_evidence':1.4,'fact':1.1,'issue':1.0,'progress':0.7}

# 旧 Markdown 库的标记只被 migrate 使用；运行期不再解析这些结构。
LEGACY_SCHEMAS = ('0.2','0.3','0.4')
LEGACY_RECORD_OPEN = re.compile(r'^<!-- memory:record (\{.*\}) -->$')
LEGACY_PROJECT_OPEN = re.compile(r'^<!-- memory:project (\{.*\}) -->$')
LEGACY_GLOBAL_OPEN = '<!-- memory:global -->'
LEGACY_SESSION_OPEN = re.compile(r'^<!-- memory:session (\{.*\}) -->$')
LEGACY_PROFILE_OPEN = re.compile(r'^<!-- memory:profile (\{.*\}) -->$')
LEGACY_SUM_OPEN = re.compile(r'^<!-- memory:summary (\{.*\}) -->$')


class MemoryError(Exception): pass


def ulid(prefix):
    alphabet='0123456789ABCDEFGHJKMNPQRSTVWXYZ'
    n=(int(time.time()*1000)<<80)|secrets.randbits(80)
    a=''
    for _ in range(26): a=alphabet[n&31]+a; n >>= 5
    return prefix+'_'+a


def j(o): return json.dumps(o,ensure_ascii=False,indent=2,sort_keys=True)+'\n'
def compact(o): return json.dumps(o,ensure_ascii=False,separators=(',',':'))
def sha(b): return hashlib.sha256(b).hexdigest()
def expect(condition, message):
    if not condition: raise MemoryError(message)


def candidate_check(text, single_line=False):
    expect(isinstance(text,str) and text.strip(),'文本不能为空')
    expect('<!-- memory:' not in text and '<!-- /memory:' not in text,'文本包含保留标记')
    if single_line: expect('\n' not in text and '\r' not in text and '<!--' not in text, '标题或项目名称必须为单行且不能含标记')
    return text.strip()


def content_key(typ, rule_key, topic, content):
    """内容指纹：去重按内容而不是会话或 ID；归一化空白，避免排版差异被当成新记录。"""
    raw=unicodedata.normalize('NFKC',f'{typ}\x1f{rule_key or ""}\x1f{topic}\x1f{content}')
    return hashlib.sha256(re.sub(r'\s+',' ',raw).strip().encode()).hexdigest()


def record_refs(record: dict, key: str) -> list[str]:
    refs=record.get(key,[])
    expect(isinstance(refs,list) and all(isinstance(v,str) for v in refs)
           and len(refs)==len(set(refs)),f'{key} 必须为不重复的 ID 数组')
    return refs


def is_active_rule(record: dict) -> bool:
    return record['type'] in RULE_TYPES and record.get('status','active')=='active'


def parse_month(value: object) -> str:
    expect(isinstance(value,str) and re.fullmatch(r'\d{4}-(0[1-9]|1[0-2])',value) is not None,'非法月份')
    return str(value)


def db_path(root: Path) -> Path:
    return root/DB_NAME


def access_time(value: object) -> dt.datetime:
    if not isinstance(value,str): raise MemoryError('ACCESS_INVALID：统计时间无效')
    parsed=dt.datetime.fromisoformat(value)
    expect(parsed.utcoffset() is not None,'ACCESS_INVALID：统计时间缺少时区')
    return parsed


def access_ids(ids: object) -> list[str]:
    """统计只接受真实日记 ID；一次调用中的重复 ID 只计一次。"""
    if not isinstance(ids,list) or not 1<=len(ids)<=50:
        raise MemoryError('访问统计须指定 1..50 个真实日记 ID')
    expect(all(isinstance(rid,str) and rid.startswith('m_') and ID_RE.fullmatch(rid) for rid in ids),
           '访问统计须指定 1..50 个真实日记 ID')
    return list(dict.fromkeys(ids))


# ---------------------------------------------------------------------------
# 连接、事务与版本
# ---------------------------------------------------------------------------

SCHEMA_SQL = """
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE records(
  id TEXT PRIMARY KEY, date TEXT NOT NULL, session_id TEXT NOT NULL, agent TEXT NOT NULL,
  saved_at TEXT NOT NULL, type TEXT NOT NULL, topic TEXT NOT NULL, title TEXT NOT NULL,
  content TEXT NOT NULL, rule_key TEXT, status TEXT NOT NULL, superseded_by TEXT,
  project_id TEXT, content_digest TEXT NOT NULL, doc_length INTEGER NOT NULL);
CREATE INDEX records_date ON records(date);
CREATE INDEX records_rule ON records(type, rule_key, project_id, status);
CREATE TABLE record_sources(record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL, PRIMARY KEY(record_id, source_id));
CREATE TABLE record_supersedes(record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL, PRIMARY KEY(record_id, target_id));
CREATE TABLE record_terms(record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  term TEXT NOT NULL, tf INTEGER NOT NULL, PRIMARY KEY(record_id, term));
CREATE INDEX record_terms_term ON record_terms(term);
CREATE TABLE profiles(id TEXT PRIMARY KEY, domain TEXT NOT NULL, scope TEXT NOT NULL,
  basis TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL);
CREATE INDEX profiles_domain ON profiles(domain);
CREATE TABLE profile_sources(profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL, PRIMARY KEY(profile_id, source_id));
CREATE TABLE summaries(month TEXT NOT NULL, position INTEGER NOT NULL, topic TEXT NOT NULL,
  content TEXT NOT NULL, generated_at TEXT NOT NULL, doc_length INTEGER NOT NULL,
  PRIMARY KEY(month, position));
CREATE TABLE summary_sources(month TEXT NOT NULL, position INTEGER NOT NULL, source_id TEXT NOT NULL,
  PRIMARY KEY(month, position, source_id));
CREATE TABLE summary_terms(month TEXT NOT NULL, position INTEGER NOT NULL, term TEXT NOT NULL,
  tf INTEGER NOT NULL, PRIMARY KEY(month, position, term));
CREATE INDEX summary_terms_term ON summary_terms(term);
CREATE TABLE access_events(record_id TEXT NOT NULL, session_hash TEXT NOT NULL,
  event_hash TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(record_id, session_hash, event_hash));
CREATE INDEX access_events_record ON access_events(record_id);
CREATE TABLE plans(plan_id TEXT PRIMARY KEY, operation TEXT NOT NULL, plan_version INTEGER NOT NULL,
  created_at REAL NOT NULL, expected_change_seq INTEGER NOT NULL, payload TEXT NOT NULL);
"""


def _connect(path: Path, write: bool) -> sqlite3.Connection:
    if write:
        conn=sqlite3.connect(str(path),timeout=BUSY_TIMEOUT_SECONDS,isolation_level=None)
    else:
        # 只读连接用 URI 模式；目录仍需可写，WAL 的共享内存索引由 SQLite 自行映射。
        conn=sqlite3.connect(path.absolute().as_uri()+'?mode=ro',uri=True,timeout=BUSY_TIMEOUT_SECONDS,isolation_level=None)
        conn.execute('PRAGMA query_only=1')
    conn.row_factory=sqlite3.Row
    conn.execute(f'PRAGMA busy_timeout={int(BUSY_TIMEOUT_SECONDS*1000)}')
    conn.execute('PRAGMA foreign_keys=ON')
    return conn


@contextlib.contextmanager
def connect(root: Path, write: bool = False):
    """短连接：每次调用开一条连接，写路径显式 BEGIN IMMEDIATE，只读路径 mode=ro。"""
    path=db_path(root)
    expect(path.is_file(),'DB_MISSING：记忆库不存在；先执行 init')
    conn=_connect(path,write)
    try: yield conn
    finally: conn.close()


@contextlib.contextmanager
def transaction(conn: sqlite3.Connection):
    """写事务：先取写锁，忙时整事务重试；失败统一回滚。"""
    acquired=False
    for attempt in range(BUSY_RETRIES):
        try:
            conn.execute('BEGIN IMMEDIATE');acquired=True;break
        except sqlite3.OperationalError as error:
            message=str(error).lower()
            if 'locked' not in message and 'busy' not in message:
                raise MemoryError(f'DB_ERROR：{error}') from error
            if attempt==BUSY_RETRIES-1: break
            time.sleep(0.05*(attempt+1))
    expect(acquired,'ACCESS_BUSY：记忆库正在操作，未完成写入')
    try:
        yield
        conn.execute('COMMIT')
    except BaseException:
        try: conn.execute('ROLLBACK')
        except sqlite3.Error: pass
        raise


def meta_value(conn: sqlite3.Connection, key: str) -> str:
    row=conn.execute('SELECT value FROM meta WHERE key=?',(key,)).fetchone()
    expect(row is not None,f'DB_INVALID：缺少元信息 {key}')
    return row[0]


def meta_patch(conn: sqlite3.Connection, values: dict) -> None:
    conn.executemany('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                     [(key,str(value)) for key,value in values.items()])


def change_seq(conn: sqlite3.Connection) -> int:
    return int(meta_value(conn,'change_seq'))


def bump(conn: sqlite3.Connection) -> int:
    """单调版本：写入与词项在同一事务内递增，替换读取侧的整库指纹。"""
    value=change_seq(conn)+1
    meta_patch(conn,{'change_seq':value})
    return value


def require_version(conn: sqlite3.Connection) -> int:
    version=conn.execute('PRAGMA user_version').fetchone()[0]
    expect(version==READABLE_VERSION,
           f'DB_VERSION：数据版本不适用（库 {version}，代码 {READABLE_VERSION}）；须执行 migrate')
    return version


def timezone_of(conn: sqlite3.Connection) -> dt.tzinfo:
    zone=meta_value(conn,'timezone')
    try: return ZoneInfo(zone)
    except (ZoneInfoNotFoundError,TypeError): raise MemoryError(f'无效/不可用的 IANA 时区: {zone}；Windows 可能需要安装 tzdata')


def recent_window(conn: sqlite3.Connection) -> int:
    window=int(meta_value(conn,'recent_window_days'))
    expect(1<=window<=366,'recent_window_days 超出合理范围')
    return window


def create_store(root: Path, timezone: str) -> dict:
    """建库入口：WAL、Schema、版本与元信息一次写入，供 init 与 migrate 共用。"""
    try: ZoneInfo(timezone)
    except ZoneInfoNotFoundError: raise MemoryError('IANA 时区不可用；Windows 可安装 tzdata')
    root.mkdir(parents=True,exist_ok=True)
    path=db_path(root)
    expect(not path.exists(),'DB_EXISTS：目标库已存在，禁止覆盖')
    conn=_connect(path,True)
    try:
        conn.execute('PRAGMA journal_mode=WAL')
        conn.execute('PRAGMA synchronous=NORMAL')
        conn.executescript(SCHEMA_SQL)
        conn.execute(f'PRAGMA user_version={STORE_VERSION}')
        meta_patch(conn,{'timezone':timezone,'recent_window_days':DEFAULT_RECENT_WINDOW,
                         'change_seq':0,'created_at':dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
                         'storage':'sqlite','search':SEARCH_ALGORITHM})
    finally: conn.close()
    return {'database':str(path),'store_version':STORE_VERSION,'timezone':timezone}


# ---------------------------------------------------------------------------
# 记录与词项
# ---------------------------------------------------------------------------

def lexical_terms(value: str) -> list[str]:
    """中文双字片段与英文词元；标识符同时保留整体和下划线片段。"""
    tokens=[]
    for run in SEARCH_TOKENS.findall(unicodedata.normalize('NFKC',value).casefold()):
        if run.isascii():parts=[run,*[part for part in run.split('_') if part and part!=run]]
        else:parts=[run] if len(run)==1 else [run[i:i+2] for i in range(len(run)-1)]
        tokens.extend(part for part in parts if part not in SEARCH_STOPWORDS)
    return tokens


def document_terms(title: str, content: str, rule_key: str | None) -> tuple[dict, int]:
    """标题与规则键的词频按三倍计入；长度包含这些加权词频，与既有打分口径一致。"""
    terms=Counter(lexical_terms(content))
    for field in dict.fromkeys([title,rule_key or '']):
        terms.update({term:count*3 for term,count in Counter(lexical_terms(field)).items()})
    return dict(terms),sum(terms.values())


def summary_terms(topic: str, content: str) -> tuple[dict, int]:
    terms=Counter(lexical_terms(content))
    terms.update({term:count*3 for term,count in Counter(lexical_terms(topic)).items()})
    return dict(terms),sum(terms.values())


def write_terms(conn: sqlite3.Connection, record_id: str, terms: dict) -> None:
    conn.executemany('INSERT INTO record_terms(record_id,term,tf) VALUES(?,?,?)',
                     [(record_id,term,tf) for term,tf in terms.items()])


def write_summary_terms(conn: sqlite3.Connection, month: str, position: int, terms: dict) -> None:
    conn.executemany('INSERT INTO summary_terms(month,position,term,tf) VALUES(?,?,?,?)',
                     [(month,position,term,tf) for term,tf in terms.items()])


PUBLIC_FIELDS=('id','date','type','topic','title','content','rule_key','status','superseded_by',
               'project_id','source_record_ids','supersedes','session')


def public_record(row: dict) -> dict:
    """对外只暴露记录语义字段；内容指纹与词项长度是实现细节，不进入工具输出。"""
    return {key:row[key] for key in PUBLIC_FIELDS if key in row}


def record_rows(conn: sqlite3.Connection, where: str = '', params: tuple = ()) -> list[dict]:
    """读取完整记录；关联字段按 ID 集合一次性补充，避免逐行查询。"""
    sql=('SELECT id,date,session_id,agent,saved_at,type,topic,title,content,rule_key,status,'
         'superseded_by,project_id,content_digest,doc_length FROM records'+(' WHERE '+where if where else ''))
    rows=[dict(row) for row in conn.execute(sql,params)]
    if not rows: return rows
    ids=[row['id'] for row in rows]
    placeholders=','.join('?'*len(ids))
    sources={}
    for rid,source in conn.execute(f'SELECT record_id,source_id FROM record_sources WHERE record_id IN ({placeholders})',ids):
        sources.setdefault(rid,[]).append(source)
    supersedes={}
    for rid,target in conn.execute(f'SELECT record_id,target_id FROM record_supersedes WHERE record_id IN ({placeholders})',ids):
        supersedes.setdefault(rid,[]).append(target)
    for row in rows:
        row['source_record_ids']=sources.get(row['id'],[])
        row['supersedes']=supersedes.get(row['id'],[])
        row['session']={'id':row.pop('session_id'),'saved_at':row['saved_at'],'agent':row.pop('agent')}
    return rows


def record_by_ids(conn: sqlite3.Connection, ids: list[str]) -> dict[str, dict]:
    if not ids: return {}
    placeholders=','.join('?'*len(ids))
    return {row['id']:row for row in record_rows(conn,f'id IN ({placeholders})',tuple(ids))}


def profile_rows(conn: sqlite3.Connection) -> list[dict]:
    rows=[dict(row) for row in conn.execute(
        'SELECT id,domain,scope,basis,title,content FROM profiles ORDER BY domain,id')]
    if not rows: return rows
    ids=[row['id'] for row in rows]
    placeholders=','.join('?'*len(ids))
    sources={}
    for pid,source in conn.execute(f'SELECT profile_id,source_id FROM profile_sources WHERE profile_id IN ({placeholders})',ids):
        sources.setdefault(pid,[]).append(source)
    for row in rows: row['source_record_ids']=sources.get(row['id'],[])
    return rows


PUBLIC_SUMMARY_FIELDS=('key','month','topic','content','source_record_ids')


def public_summary(row: dict) -> dict:
    """摘要只对外暴露来源与正文；词项长度是实现细节。"""
    return {key:row[key] for key in PUBLIC_SUMMARY_FIELDS if key in row}


def summary_rows(conn: sqlite3.Connection, month: str | None = None) -> list[dict]:
    sql=('SELECT month,position,topic,content,generated_at,doc_length FROM summaries'
         +(' WHERE month=?' if month else '')+' ORDER BY month,position')
    rows=[dict(row) for row in conn.execute(sql,(month,) if month else ())]
    if not rows: return rows
    pairs=[(row['month'],row['position']) for row in rows]
    sources={}
    for m,pos,source in conn.execute('SELECT month,position,source_id FROM summary_sources '
                                     'WHERE '+('month=?' if month else '1=1'),(month,) if month else ()):
        sources.setdefault((m,pos),[]).append(source)
    for row in rows:
        row['source_record_ids']=sources.get((row['month'],row['position']),[])
        row['key']=f'summary:{row["month"]}:{row["position"]}'
    return rows


def month_status(conn: sqlite3.Connection) -> dict[str, dict]:
    months={}
    for row in conn.execute('SELECT substr(date,1,7) AS month,COUNT(*) AS n FROM records GROUP BY month'):
        months[row['month']]={'record_count':row['n'],'summary_available':False}
    for row in conn.execute('SELECT DISTINCT month FROM summaries'):
        months.setdefault(row['month'],{'record_count':0,'summary_available':False})['summary_available']=True
    return months


def withdraw_month(conn: sqlite3.Connection, month: str) -> None:
    """新增或删除记录会使已生成的当月摘要失真，按既有语义撤回而不是就地改写。"""
    conn.execute('DELETE FROM summary_terms WHERE month=?',(month,))
    conn.execute('DELETE FROM summary_sources WHERE month=?',(month,))
    conn.execute('DELETE FROM summaries WHERE month=?',(month,))


# ---------------------------------------------------------------------------
# 校验（库内一致性，不再比对文件）
# ---------------------------------------------------------------------------

def validate_state(conn: sqlite3.Connection) -> tuple[list[dict],list[dict]]:
    recs=record_rows(conn)
    profiles=profile_rows(conn)
    refmap={r['id']:r for r in recs}
    valid_ids=set(refmap)
    unique={}
    for r in recs:
        expect(ID_RE.fullmatch(r['id']) is not None,'非法记忆 ID: '+r['id'])
        expect(re.fullmatch(r'\d{4}-\d{2}-\d{2}',r['date']) is not None and _valid_date(r['date']),
               '记录日期无效: '+r['id'])
        expect(r['type'] in TYPES,'未知记录类型')
        expect(r['status'] in ('active','superseded'),'非法记录状态')
        expect(r['project_id'] is None or (isinstance(r['project_id'],str)
               and PROJECT_ID_RE.fullmatch(r['project_id']) is not None),'项目归属无效')
        sources=record_refs(r,'source_record_ids')
        expect(set(sources).issubset(valid_ids) and r['id'] not in sources,'日记来源不存在或引用自身')
        supersedes=record_refs(r,'supersedes')
        expect(set(supersedes).issubset(valid_ids) and r['id'] not in supersedes,'替代目标不存在或引用自身')
        if r['type'] in RULE_TYPES:
            expect(isinstance(r.get('rule_key'),str) and r['rule_key'].strip(),'规则记录缺少 rule_key')
            if is_active_rule(r):
                k=(r.get('project_id'),r['rule_key'])
                expect(k not in unique,f'重复有效规则: {k}')
                unique[k]=r['id']
            for rid in supersedes:
                old=refmap[rid]
                expect(old['type'] in RULE_TYPES and old['status']=='superseded'
                       and old.get('superseded_by')==r['id'],'替代关系必须指向已被明确替代的规则')
        else:
            expect(not supersedes and r['status']=='active' and not r.get('superseded_by'),
                   '非规则日记不能参与有效版本替代')
        successor=r.get('superseded_by')
        if successor is not None:
            expect(isinstance(successor,str) and successor in valid_ids,'后继规则不存在')
            newer=refmap[successor]
            expect(r['status']=='superseded' and newer['type'] in RULE_TYPES
                   and r['id'] in record_refs(newer,'supersedes'),'后继规则与替代关系不一致')
    for r in recs:
        seen={r['id']};successor=r.get('superseded_by')
        while successor:
            expect(successor not in seen,'规则替代关系存在循环')
            seen.add(successor);successor=refmap[successor].get('superseded_by')
    profile_ids=set()
    for p in profiles:
        expect(ID_RE.fullmatch(p['id']) is not None,'非法画像 ID')
        expect(p['id'] not in profile_ids,'画像 ID 重复');profile_ids.add(p['id'])
        expect(p['domain'] in DOMAINS,'画像领域无效')
        expect(p['scope']=='global' or re.fullmatch(r'(domain|project):[a-z0-9-]+',p['scope']) is not None,
               '画像历史作用域无效')
        expect(set(record_refs(p,'source_record_ids')).issubset(valid_ids),'画像引用了已经删除的来源记忆')
    for s in summary_rows(conn):
        ids=record_refs(s,'source_record_ids')
        expect(ids and set(ids).issubset(valid_ids),f'摘要来源已丢失: {s["month"]}')
        expect(all(refmap[rid]['date'][:7]==s['month'] for rid in ids),'摘要跨越指定月份')
        candidate_check(s['topic'],True);candidate_check(s['content'])
    return recs,profiles


def _valid_date(value: str) -> bool:
    try: dt.date.fromisoformat(value);return True
    except ValueError: return False


# ---------------------------------------------------------------------------
# 词法检索（打分口径与旧实现一致）
# ---------------------------------------------------------------------------

def _placeholders(values: list | tuple) -> str:
    return ','.join('?'*len(values))


def record_context(conn: sqlite3.Connection, tokens: set[str], where: str = '', params: tuple = ()) -> tuple[int, dict, dict, float]:
    """一次取候选文档、全集文档数、全集平均长度与查询词的全集文档频率。"""
    total=conn.execute('SELECT COUNT(*) FROM records'+(' WHERE '+where if where else ''),params).fetchone()[0]
    average=conn.execute('SELECT AVG(doc_length) FROM records'+(' WHERE '+where if where else ''),params).fetchone()[0] or 1
    if not tokens: return total,{}, {}, average
    ordered=sorted(tokens)
    marks=_placeholders(ordered)
    condition=(' WHERE '+where+' AND ') if where else ' WHERE '
    frequency={row[0]:row[1] for row in conn.execute(
        'SELECT t.term,COUNT(DISTINCT t.record_id) FROM record_terms t JOIN records r ON r.id=t.record_id'
        +condition+f't.term IN ({marks}) GROUP BY t.term',(*params,*ordered))}
    docs={}
    for rid,term,tf,length,kind in conn.execute(
            'SELECT t.record_id,t.term,t.tf,r.doc_length,r.type FROM record_terms t JOIN records r ON r.id=t.record_id'
            +condition+f't.term IN ({marks})',(*params,*ordered)):
        doc=docs.get(rid)
        if doc is None:
            doc={'key':'record:'+rid,'id':rid,'type':kind,'terms':{},'length':length};docs[rid]=doc
        doc['terms'][term]=tf
    return total,frequency,docs,average


def summary_context(conn: sqlite3.Connection, tokens: set[str], month: str | None = None,
                    project: str | None = None) -> tuple[int, dict, dict, float]:
    """一次取摘要候选、全集摘要数、平均长度与查询词的文档频率。

    project 只收窄来源项目：月摘要没有自己的归属列，按来源记录判定，
    含该项目或无归属来源的摘要仍保留，否则收窄后摘要层会被整体隐去。
    """
    clauses=[];params=[]
    if month:
        clauses.append('s.month=?');params.append(month)
    if project is not None:
        expect(PROJECT_ID_RE.fullmatch(project) is not None,'项目范围须为注册表 UUID')
        clauses.append('EXISTS (SELECT 1 FROM summary_sources ss JOIN records r ON r.id=ss.source_id '
                       'WHERE ss.month=s.month AND ss.position=s.position AND (r.project_id IS NULL OR r.project_id=?))')
        params.append(project)
    where=(' WHERE '+' AND '.join(clauses)) if clauses else ''
    total=conn.execute('SELECT COUNT(*) FROM summaries s'+where,params).fetchone()[0]
    average=conn.execute('SELECT AVG(s.doc_length) FROM summaries s'+where,params).fetchone()[0] or 1
    if not tokens: return total,{}, {}, average
    ordered=sorted(tokens)
    marks=_placeholders(ordered)
    term_where=where+(' AND ' if where else ' WHERE ')+f't.term IN ({marks})'
    joined=' FROM summary_terms t JOIN summaries s ON s.month=t.month AND s.position=t.position'
    frequency={row[0]:row[1] for row in conn.execute(
        'SELECT t.term,COUNT(*)'+joined+term_where+' GROUP BY t.term',(*params,*ordered))}
    docs={}
    for m,pos,term,tf,length in conn.execute(
            'SELECT t.month,t.position,t.term,t.tf,s.doc_length'+joined+term_where,(*params,*ordered)):
        key=(m,pos);doc=docs.get(key)
        if doc is None:
            doc={'key':f'summary:{m}:{pos}','month':m,'position':pos,'terms':{},'length':length};docs[key]=doc
        doc['terms'][term]=tf
    return total,frequency,docs,average


def rank_documents(total: int, frequency: dict, documents: dict, average: float, query: str) -> list[tuple[dict,float,list[str]]]:
    """相关性先于时间与项目；不将其他项目的历史决定提升为当前规则。"""
    tokens=set(lexical_terms(query))
    if not tokens or not documents: return []
    ranked=[]
    for doc in documents.values():
        hits=sorted(tokens.intersection(doc['terms']))
        if not hits: continue
        score=0.0
        for term in hits:
            count=doc['terms'][term];seen=frequency.get(term,0)
            weight=math.log1p((total-seen+0.5)/(seen+0.5))
            score+=weight*count*2.2/(count+1.2*(0.25+0.75*doc['length']/average))
        ranked.append((doc,score*len(hits)/len(tokens),hits))
    ranked.sort(key=lambda item:(-item[1],item[0]['key']))
    return ranked


def truncate(content: str, limit: int = 200) -> tuple[str, bool]:
    if len(content) <= limit: return content, False
    return content[:limit] + '...', True


def project_clause(project: str | None) -> tuple[str, tuple]:
    """项目范围收窄条件：只保留该项目与无归属记录，其余来源项目的记录不返回。

    无归属记录承载跨项目约定，收窄时不能被一并滤掉；筛选用 SQL 完成，分页前生效。
    """
    if project is None: return '', ()
    expect(PROJECT_ID_RE.fullmatch(project) is not None,'项目范围须为注册表 UUID')
    return '(project_id IS NULL OR project_id=?)',(project,)


def indexed_recall(root: Path, query: str, mode: str = 'records',
                   month: str | None = None, offset: int = 0, limit: int = 50, allow_empty: bool = False,
                   project: str | None = None) -> dict:
    """词法召回；content 截断为前 200 字摘要，完整正文需二次调用 read。"""
    expect(mode in ('records','recent','historical','month'),'非法检索模式')
    expect(offset>=0 and 1<=limit<=200,'offset/limit 非法；每批最多 200 条')
    expect(allow_empty or bool(query.strip()),'检索问题不能为空')
    expect((mode=='month' and isinstance(month,str) and re.fullmatch(r'\d{4}-(0[1-9]|1[0-2])',month))
           or (mode!='month' and month is None),'月份必须明确且仅用于 month 模式')
    project_where,project_params=project_clause(project)
    with connect(root) as conn:
        require_version(conn)
        zone=timezone_of(conn);version=change_seq(conn)
        tokens=set(lexical_terms(query))
        if mode in ('historical','month'):
            total,frequency,docs,average=summary_context(conn,tokens,month if mode=='month' else None,project)
            if tokens:
                ranked=rank_documents(total,frequency,docs,average,query)
            else:
                ranked=[({'key':row['key'],'month':row['month'],'position':row['position']},0.0,[])
                        for row in sorted(summary_rows(conn,month if mode=='month' else None),
                                          key=lambda row:row['key'])]
            page=ranked[offset:offset+limit]
            rows=summary_rows(conn,month if mode=='month' else None)
            by_key={(row['month'],row['position']):row for row in rows}
            selected=[public_summary(by_key[(item[0]['month'],item[0]['position'])]) for item in page]
            missing=mode=='month' and not any(row['month']==month for row in rows)
            scope={'historical':'historical_month_summaries','month':'monthly_summary'}[mode]
        else:
            where=project_where;params=project_params
            if mode=='recent':
                window=recent_window(conn)
                today=dt.datetime.now(zone).date();first=(today-dt.timedelta(days=window-1)).isoformat()
                where=(where+' AND ' if where else '')+'date>=? AND date<=?'
                params=(*params,first,today.isoformat())
            total,frequency,docs,average=record_context(conn,tokens,where,params)
            ranked=rank_documents(total,frequency,docs,average,query) if tokens else []
            if not tokens:
                fallback=record_rows(conn,where,params)
                fallback.sort(key=lambda r:r['id'])
                ranked=[({'key':'record:'+r['id'],'id':r['id']},0.0,[]) for r in fallback]
            page=ranked[offset:offset+limit]
            fetched=record_by_ids(conn,[item[0]['id'] for item in page])
            selected=[public_record(fetched[item[0]['id']]) for item in page]
            missing=False
            scope={'records':'all_daily','recent':'recent_daily'}[mode]
        matches=[]
        for row,item in zip(selected,page):
            body,was_truncated=truncate(row['content'])
            matches.append({**row,'kind':'summary' if 'key' in row else 'record','content':body,
                            'content_truncated':was_truncated,'score':round(item[1],6),'matched_terms':item[2]})
    return {'status':'MONTHLY_SUMMARY_MISSING' if missing else 'OK','scope':scope,'memory_scope':'global',
            'mode':mode,'month':month,'query':query,'project':project,'store_version':version,'coverage':'store_records',
            'matches':matches,'total_matches':len(ranked),'offset':offset,'limit':limit,
            'has_more':offset+limit<len(ranked),'next_offset':offset+limit if offset+limit<len(ranked) else None,
            'no_match':not ranked,'note':'仅词法相关性；历史来源与状态不代表当前适用或事实已核实；摘要需 memory_read 读取全文'}


def layered_recall(root: Path, query: str, offset: int = 0, limit: int = 50,
                   project: str | None = None) -> dict:
    """按时间分层召回：近窗口日记与更早月份的月摘要代表同池排序，缺摘要的月份回退限量日记。

    候选先合并再一次打分，否则分池排序的 BM25 分数不可比；每月配额与层标记在排序之后施加。
    """
    expect(offset>=0 and 1<=limit<=200,'offset/limit 非法；每批最多 200 条')
    expect(bool(query.strip()),'检索问题不能为空')
    project_where,project_params=project_clause(project)
    with connect(root) as conn:
        require_version(conn)
        zone=timezone_of(conn);version=change_seq(conn)
        window=recent_window(conn)
        today=dt.datetime.now(zone).date();cutoff=(today-dt.timedelta(days=window-1)).isoformat()
        tokens=set(lexical_terms(query))
        record_total,frequency,documents,average=record_context(conn,tokens,project_where,project_params)
        summary_total,summary_frequency,summary_documents,summary_average=summary_context(conn,tokens,project=project)
        if summary_total:
            average=(average*record_total+summary_average*summary_total)/(record_total+summary_total)
        for term,count in summary_frequency.items(): frequency[term]=frequency.get(term,0)+count
        documents.update(summary_documents)
        for document in summary_documents.values(): document['summary']=True
        dates={row[0]:row[1] for row in conn.execute(
            'SELECT id,date FROM records'+(' WHERE '+project_where if project_where else ''),project_params)}
        summary_months={row[0] for row in conn.execute('SELECT DISTINCT month FROM summaries')}
        ranked=rank_documents(record_total+summary_total,frequency,documents,average,query)
        kept=[];fallback_counts=Counter();summary_counts=Counter()
        for document,score,hits in ranked:
            if document.get('summary'):
                if summary_counts[document['month']]>=1: continue
                summary_counts[document['month']]+=1;layer='summary'
            else:
                date=dates.get(document['id'],'')
                if date>=cutoff: layer='recent'
                else:
                    month=date[:7]
                    # 该月已有摘要时由摘要代表，否则每月最多回退两条，避免远期日记挤占同一批结果。
                    if month in summary_months or fallback_counts[month]>=2: continue
                    fallback_counts[month]+=1;layer='fallback'
            kept.append((document,score,hits,layer))
        page=kept[offset:offset+limit]
        fetched=record_by_ids(conn,[item[0]['id'] for item in page if not item[0].get('summary')])
        summaries={(row['month'],row['position']):row for row in summary_rows(conn)}
        matches=[]
        for document,score,hits,layer in page:
            if document.get('summary'):
                row=public_summary(summaries[(document['month'],document['position'])]);kind='summary'
            else:
                row=public_record(fetched[document['id']]);kind='record'
            body,was_truncated=truncate(row['content'])
            matches.append({**row,'kind':kind,'content':body,'content_truncated':was_truncated,
                            'layer':layer,'score':round(score,6),'matched_terms':hits})
        layers=Counter(item[3] for item in kept)
        older_months={date[:7] for date in dates.values() if date<cutoff}
        missing=sorted(month for month in older_months if month not in summary_months)[:12]
    return {'status':'OK','scope':'layered_recent_and_monthly','memory_scope':'global',
            'mode':'auto','query':query,'project':project,'window_days':window,'cutoff':cutoff,
            'store_version':version,'coverage':'store_records',
            'matches':matches,'total_matches':len(kept),'offset':offset,'limit':limit,
            'has_more':offset+limit<len(kept),'next_offset':offset+limit if offset+limit<len(kept) else None,
            'no_match':not kept,'missing_summaries':missing,
            'layers':{'recent':layers['recent'],'summary':layers['summary'],'fallback':layers['fallback']},
            'note':'近窗口内查日记，更早月份优先用月摘要；缺摘要的月份回退该月最多两条日记。仅词法相关性，历史来源不代表当前适用'}


def background_recall(root: Path, data: dict) -> dict:
    """自动背景专用只读入口；共享词法核心，缓存只按库版本判定。"""
    allowed={'query','recent','date_from','date_to','cache_key','cached_ids'}
    expect(isinstance(data,dict) and not set(data)-allowed,'自动召回输入字段无效')
    query=data.get('query')
    expect(isinstance(query,str) and 0<len(query.strip())<=2000,'自动召回需要有界任务查询')
    recent=data.get('recent',False)
    expect(type(recent) is bool,'recent 必须为布尔值')
    first,last=data.get('date_from'),data.get('date_to')
    expect(not recent or (first is None and last is None),'近期与明确日期范围不能混用')
    for value in (first,last):
        if value is not None:
            expect(isinstance(value,str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}',value) is not None,'日期范围须为 YYYY-MM-DD')
            dt.date.fromisoformat(value)
    cached_ids=data.get('cached_ids',[]);cached_key=data.get('cache_key')
    expect(isinstance(cached_ids,list) and len(cached_ids)<=6
           and all(isinstance(rid,str) and rid.startswith('m_') and ID_RE.fullmatch(rid) for rid in cached_ids)
           and len(set(cached_ids))==len(cached_ids),'自动召回缓存身份无效')
    expect(cached_key is None or (isinstance(cached_key,str) and re.fullmatch(r'[0-9a-f]{64}',cached_key)),
           '自动召回缓存键无效')
    expect(cached_key is not None or not cached_ids,'缓存 ID 缺少所属版本')
    with connect(root) as conn:
        require_version(conn)
        zone=timezone_of(conn);version=change_seq(conn)
        if recent:
            window=recent_window(conn)
            today=dt.datetime.now(zone).date()
            first=(today-dt.timedelta(days=window-1)).isoformat();last=today.isoformat()
        expect(first is None or last is None or first<=last,'日期范围顺序无效')
        scope={'memory_scope':'global','date_from':first,'date_to':last}
        cache_key=sha(compact([BACKGROUND_POLICY,version,query,scope]).encode())
        base={'policy':BACKGROUND_POLICY,'store_version':version,'cache_key':cache_key,
              'scope':scope,'coverage':'store_records'}
        where=['status=?'];params=['active']
        if first is not None: where.append('date>=?');params.append(first)
        if last is not None: where.append('date<=?');params.append(last)
        condition=' AND '.join(where)
        if cached_ids:
            by_id=record_by_ids(conn,cached_ids)
            rows=[by_id.get(rid) for rid in cached_ids]
            expect(all(row is not None for row in rows),'缓存记录不属于当前候选范围')
            expect(all(row['status']=='active' for row in rows),'缓存记录不属于当前候选范围')
            if cached_key==cache_key: return {**base,'unchanged':True,'ids':cached_ids}
        terms={term for term in lexical_terms(query) if term not in BACKGROUND_STOPWORDS}
        total,frequency,docs,average=record_context(conn,terms,condition,tuple(params))
        ranked=rank_documents(total,frequency,docs,average,' '.join(sorted(terms))) if terms else []
        # 先按类型权重重排，再套相关度门槛与相对截断，保证规则类条目先获得名额。
        ranked=[(doc,score*TYPE_WEIGHT.get(doc.get('type',''),1.0),hits) for doc,score,hits in ranked]
        ranked.sort(key=lambda item:(-item[1],item[0]['key']))
        eligible=[item for item in ranked if len(item[2])>=min(2,len(terms))
                  and len(item[2])/max(1,len(terms))>=0.12]
        if eligible: eligible=[item for item in eligible if item[1]>=eligible[0][1]*0.45]
        selected=[];counts={'rule':0,'history':0}
        for item in eligible:
            group='rule' if item[0].get('type') in RULE_TYPES else 'history'
            if counts[group]>=3: continue
            counts[group]+=1;selected.append(item)
        rows=record_by_ids(conn,[item[0]['id'] for item in selected])
        fields=('id','type','topic','title','content','project_id','date','status','source_record_ids','rule_key')
        matches=[{**{key:rows[item[0]['id']][key] for key in fields if key in rows[item[0]['id']]},
                  'score':round(item[1],6),'matched_terms':item[2]} for item in selected]
        reason=None if matches else ('no_terms' if not terms else 'no_overlap' if not ranked else 'below_threshold')
    return {**base,'unchanged':False,'matches':matches,'ids':[row['id'] for row in matches],
            'no_match':not matches,'reason':reason,'eligible_count':len(eligible),
            'note':'自动词法筛选不证明适用性或事实正确；被替代规则不自动注入，完整历史仍可手动查询。'}


def error_recall(root: Path, data: dict) -> dict:
    """报错指纹专用检索：仅匹配 type=issue 的日记记录。"""
    allowed={'fingerprint','limit'}
    expect(isinstance(data,dict) and not set(data)-allowed,'报错召回输入字段无效')
    fingerprint=data.get('fingerprint')
    expect(isinstance(fingerprint,str) and 0<len(fingerprint.strip())<=500,'报错指纹须为有界特征串')
    limit=data.get('limit',3)
    expect(isinstance(limit,int) and 1<=limit<=10,'报错召回数量限制无效')
    with connect(root) as conn:
        require_version(conn)
        version=change_seq(conn)
        tokens=set(lexical_terms(fingerprint.strip()))
        total,frequency,docs,average=record_context(conn,tokens,'type=?',('issue',))
        ranked=rank_documents(total,frequency,docs,average,fingerprint.strip())
        eligible=[item for item in ranked if len(item[2])>=2]
        selected=eligible[:limit]
        rows=record_by_ids(conn,[item[0]['id'] for item in selected])
        fields=('id','type','topic','title','content','project_id','date','status','source_record_ids')
        matches=[{**{key:rows[item[0]['id']][key] for key in fields if key in rows[item[0]['id']]},
                  'score':round(item[1],6),'matched_terms':item[2]} for item in selected]
    return {'policy':'error-fingerprint-v1','store_version':version,'fingerprint':fingerprint,
            'memory_scope':'global','matches':matches,'no_match':not matches,
            'note':'报错指纹联动仅匹配 issue 类型日记；不自动沉淀新记录，写入仍只在用户明确要求时进行。'}


def indexed_read(root: Path, ids: list[str]) -> dict:
    expect(1<=len(ids)<=50 and all(isinstance(rid,str) and rid.startswith('m_')
           and ID_RE.fullmatch(rid) is not None for rid in ids),'须指定 1..50 个真实日记 ID')
    with connect(root) as conn:
        require_version(conn)
        version=change_seq(conn)
        by_id=record_by_ids(conn,ids)
        expect(all(rid in by_id for rid in ids),'指定记忆 ID 不存在，未扫描历史')
        return {'records':[public_record(by_id[rid]) for rid in ids],'memory_scope':'global',
                'store_version':version,'coverage':'store_records'}


def active_rules(root: Path, query: str = '', offset: int = 0, limit: int = 50,
                 project: str | None = None) -> dict:
    """查询全局库有效规则；历史来源保持原命名空间，不因同键而合并。

    project 为注册表 UUID 时只收窄来源项目，无归属的通用约定仍保留，筛选用 SQL 在分页前完成。
    """
    expect(offset>=0 and 1<=limit<=200,'offset/limit 非法；每批最多 200 条')
    project_where,project_params=project_clause(project)
    with connect(root) as conn:
        require_version(conn)
        version=change_seq(conn)
        where='type IN (?,?) AND status=?'+(' AND '+project_where if project_where else '')
        params=tuple(sorted(RULE_TYPES))+('active',)+project_params
        rows=record_rows(conn,where,params)
        total=len(rows)
        if query.strip():
            tokens=set(lexical_terms(query))
            _,frequency,docs,average=record_context(conn,tokens,where,params)
            order=[item[0]['id'] for item in rank_documents(total,frequency,docs,average,query)]
            index={row['id']:row for row in rows}
            ordered=[index[rid] for rid in order if rid in index]
        else:
            ordered=sorted(rows,key=lambda r:(r['date'],r['project_id'] or '',r['rule_key'] or '',r['id']),reverse=True)
        page=ordered[offset:offset+limit]
        rules=[]
        for r in page:
            body,was_truncated=truncate(r['content'])
            rules.append({'id':r['id'],'date':r['date'],'source_project':r['project_id'],'status':'active',
                          'rule_key':r['rule_key'],'type':r['type'],'topic':r['topic'],'content':body,
                          'content_truncated':was_truncated,'source_record_ids':r['source_record_ids'],
                          'supersedes':r['supersedes']})
        return {'memory_scope':'global','project':project,'total_rules':total,'offset':offset,'limit':limit,
                'store_version':version,'coverage':'store_records',
                'has_more':offset+limit<total,'next_offset':offset+len(page) if offset+limit<total else None,
                'rules':rules,'note':'返回摘要，完整正文需调用 memory_read'}


def project_notes(root: Path, project: str, date_from: str, limit: int = 3) -> dict:
    """按项目与日期窗口读取进展、问题与事实，供每轮背景的「当前项目近况」段使用。

    不做词法筛选也不做族收敛：这一段的语义是「这个项目最近在做什么」，口径必须可预测。
    只读且只收 active；规则类记录由 `rules` 提供，不在这里重复。
    """
    expect(isinstance(project,str) and PROJECT_ID_RE.fullmatch(project) is not None,
           '项目范围须为注册表 UUID')
    expect(isinstance(date_from,str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}',date_from) is not None,
           '近况起始日期须为 YYYY-MM-DD')
    expect(isinstance(limit,int) and 1<=limit<=10,'近况条数非法；每批 1～10 条')
    types=tuple(sorted(NOTE_TYPES))
    placeholders=','.join('?'*len(types))
    with connect(root) as conn:
        require_version(conn)
        version=change_seq(conn)
        rows=record_rows(conn,f'type IN ({placeholders}) AND status=? AND project_id=? AND date>=?',
                         types+('active',project,date_from))
    ordered=sorted(rows,key=lambda r:(r['date'],r['id']),reverse=True)[:limit]
    return {'memory_scope':'global','project':project,'date_from':date_from,'limit':limit,
            'store_version':version,'coverage':'store_records',
            'records':[public_record(r) for r in ordered],
            'note':'近况只作历史状态，不构成约定；正文未按词法筛选，也不参与族收敛'}


def profiles_view(root: Path, domain: str | None = None) -> dict:
    with connect(root) as conn:
        require_version(conn)
        rows=[row for row in profile_rows(conn) if not domain or row['domain']==domain]
    return {'memory_scope':'global','profiles':rows}


def months_view(root: Path) -> dict:
    with connect(root) as conn:
        require_version(conn)
        return {'months':month_status(conn)}


def month_closed(month, zone, closed_today_confirmed=False):
    expect(re.fullmatch(r'\d{4}-(0[1-9]|1[0-2])',month),'非法月份')
    now=dt.datetime.now(zone)
    current=now.strftime('%Y-%m')
    last=(now+dt.timedelta(days=1)).month!=now.month
    expect(month<current or (month==current and last and closed_today_confirmed is True),
           '目标月份尚未结束，拒绝生成正式摘要')


def monthly_source(root: Path, month: str, offset: int = 0, limit: int = 50, closed_today_confirmed: bool = False) -> dict:
    month=parse_month(month)
    expect(offset>=0 and 1<=limit<=200,'offset/limit 非法；每批最多 200 条')
    with connect(root) as conn:
        require_version(conn)
        zone=timezone_of(conn)
        month_closed(month,zone,closed_today_confirmed)
        selected=[r for r in record_rows(conn,'substr(date,1,7)=?',(month,))]
        selected.sort(key=lambda r:(r['date'],r['session']['saved_at'],r['id']))
        page=selected[offset:offset+limit]
        return {'memory_scope':'global','month':month,'total_records':len(selected),'offset':offset,'limit':limit,
                'has_more':offset+limit<len(selected),
                'next_offset':offset+len(page) if offset+limit<len(selected) else None,
                'records':[{'id':r['id'],'source_project':r['project_id'],'date':r['date'],
                            'session_id':r['session']['id'],'type':r['type'],'topic':r['topic'],
                            'rule_key':r['rule_key'],'content':r['content'],'status':r['status'],
                            'superseded_by':r['superseded_by'],'source_record_ids':r['source_record_ids']}
                           for r in page]}


# ---------------------------------------------------------------------------
# 访问统计
# ---------------------------------------------------------------------------

def access_summary(conn: sqlite3.Connection) -> dict:
    started=conn.execute("SELECT value FROM meta WHERE key='access_started_at'").fetchone()
    rows=conn.execute('SELECT record_id,COUNT(*) AS reads,COUNT(DISTINCT session_hash) AS sessions,'
                      'MAX(at) AS last_at FROM access_events GROUP BY record_id').fetchall()
    return {'started_at':started[0] if started else None,
            'records':{row['record_id']:{'read_count':row['reads'],'session_count':row['sessions'],
                                         'last_read_at':row['last_at']} for row in rows}}


def access_metrics(row: dict | None) -> dict:
    return {'observed':row is not None,'read_count':row['read_count'] if row else 0,
            'session_count':row['session_count'] if row else 0,
            'last_read_at':row['last_read_at'] if row else None}


def access_status(root: Path) -> dict:
    """统计故障只在状态中报告，不使成功的权威记忆读取变成统计故障。"""
    try:
        with connect(root) as conn:
            require_version(conn)
            state=access_summary(conn)
            return {'automatic':True,'status':'available' if state['started_at'] else 'not_collected',
                    'storage':'database','started_at':state['started_at'],
                    'tracked_records':len(state['records']),'note':ACCESS_NOTE}
    except (MemoryError,ValueError,KeyError,TypeError,UnicodeError,OSError,sqlite3.Error) as error:
        return {'automatic':True,'status':'unavailable','storage':'database',
                'error':str(error)[:1024],'note':ACCESS_NOTE}


def indexed_access_stats(root: Path, ids: list[str]) -> dict:
    ids=access_ids(ids)
    with connect(root) as conn:
        require_version(conn)
        version=change_seq(conn)
        by_id=record_by_ids(conn,ids)
        expect(all(rid in by_id for rid in ids),'指定统计 ID 不存在，未扫描历史')
        state=access_summary(conn)
        return {'status':'available' if state['started_at'] else 'not_collected','automatic':True,
                'started_at':state['started_at'],'store_version':version,
                'coverage':'recorded_accesses_only','note':ACCESS_NOTE,'memory_scope':'global',
                'records':[{'id':rid,'source_project':by_id[rid]['project_id'],'date':by_id[rid]['date'],
                            'status':by_id[rid]['status'],**access_metrics(state['records'].get(rid))} for rid in ids]}


def record_access(root: Path, data: dict) -> dict:
    """调用方已准备完整结果；在写事务内去重并写入单份技术统计。"""
    expect(isinstance(data,dict) and set(data)=={'ids','session_id','tool_call_id','store_version'},
           '访问事件字段无效；不接受外部计数、时间或正文')
    ids=access_ids(data['ids'])
    for key in ('session_id','tool_call_id'):
        expect(isinstance(data[key],str) and bool(data[key].strip()) and len(data[key])<=512,
               '访问事件身份无效: '+key)
    expect(isinstance(data['store_version'],str) and re.fullmatch(r'\d{1,19}',data['store_version']) is not None,
           '访问来源版本无效')
    with connect(root,write=True) as conn:
        require_version(conn)
        with transaction(conn):
            expect(str(change_seq(conn))==data['store_version'],
                   'SOURCE_CHANGED：读取后来源版本已变化，未计入访问统计')
            placeholders=_placeholders(ids)
            available={row[0] for row in conn.execute(f'SELECT id FROM records WHERE id IN ({placeholders})',ids)}
            expect(set(ids).issubset(available),'访问记录已不存在，未写统计')
            now=dt.datetime.now(dt.timezone.utc).isoformat(timespec='milliseconds')
            session=sha(('pi-memory.access.session\0'+data['session_id']).encode())
            event=sha(('pi-memory.access.call\0'+data['session_id']+'\0'+data['tool_call_id']).encode())
            added=0
            if conn.execute("SELECT 1 FROM meta WHERE key='access_started_at'").fetchone() is None:
                meta_patch(conn,{'access_started_at':now})
            for rid in ids:
                before=conn.total_changes
                conn.execute('INSERT OR IGNORE INTO access_events(record_id,session_hash,event_hash,at) VALUES(?,?,?,?)',
                             (rid,session,event,now))
                if conn.total_changes>before: added+=1
    return {'status':'recorded' if added else 'duplicate','new_records':added,
            'duplicate_records':len(ids)-added}


# ---------------------------------------------------------------------------
# 计划与提交
# ---------------------------------------------------------------------------

def prepare(root: Path, op: str, data: dict) -> dict:
    allowed={'save':{'agent','session_id','records','project_id'},
             'delete':{'ids'},
             'profile':{'domain','scope','basis','title','content','source_record_ids','replace_profile_ids'},
             'month':{'month','topics','closed_today_confirmed','rebuild_existing'}}
    expect(op in allowed and isinstance(data,dict) and not set(data)-allowed[op],
           '全局记忆候选包含不支持字段；不接受项目登记参数')
    with connect(root) as conn:
        require_version(conn)
        zone=timezone_of(conn)
        records,_=validate_state(conn)
        existing_ids={r['id']:r for r in records}
        if op=='save':
            now=dt.datetime.now(zone);date=now.date().isoformat();saved_at=now.isoformat(timespec='seconds')
            session_id=data.get('session_id') or ulid('s')
            expect(isinstance(session_id,str) and ID_RE.fullmatch(session_id) is not None,'非法 session_id')
            # 归属由宿主从项目注册表解析；拿不到时留空，不根据路径或名称推测。
            project_id=data.get('project_id')
            expect(project_id is None or (isinstance(project_id,str) and PROJECT_ID_RE.fullmatch(project_id) is not None),
                   '项目归属必须是项目注册表的 UUID 或留空')
            out=[];supersede=[];seen_keys=set();superseded_ids=set()
            seen_content={r['content_digest'] for r in records}
            duplicates=[]
            for item in data.get('records',[]):
                expect(isinstance(item,dict) and not set(item)-{'type','topic','content','rule_key','source_record_ids',
                       'supersede_record_ids','supersession_reason'},'记录字段无效；不接受项目绑定字段')
                typ=item['type'];expect(typ in TYPES,'非法记忆类型')
                expect('replace_record_ids' not in item and 'replacement_reason' not in item,
                       '旧替换协议不再接受；请用 supersede_record_ids / supersession_reason，历史不会删除')
                rule_key=item.get('rule_key');targets=[]
                explicit_ids=record_refs(item,'supersede_record_ids')
                sources=record_refs(item,'source_record_ids')
                expect(set(sources).issubset(existing_ids),'日记引用了未知来源 ID')
                if typ in RULE_TYPES:
                    expect(isinstance(rule_key,str) and rule_key.strip(),'规则需要 rule_key')
                    expect(rule_key not in seen_keys,'本次候选规则键重复');seen_keys.add(rule_key)
                    for r in records:
                        if r.get('project_id')==project_id and r.get('rule_key')==rule_key and is_active_rule(r):
                            targets.append((r,'相同 rule_key 的新决定取代旧决定，旧正文保留'))
                    for rid in explicit_ids:
                        expect(rid in existing_ids,'显式替代目标 ID 不存在: '+rid)
                        previous=existing_ids[rid]
                        expect(is_active_rule(previous),'显式替代只能指向当前有效规则: '+rid)
                        expect(all(r['id']!=rid for r,_ in targets),'同键目标已自动列入，不要重复显式指定')
                        targets.append((previous,candidate_check(item.get('supersession_reason',''))))
                else:
                    expect(not rule_key and not explicit_ids,'非规则日记不能带规则键或替代目标')
                title=candidate_check(item['topic'],True);content=candidate_check(item['content'])
                digest=content_key(typ,rule_key,title,content)
                if digest in seen_content:
                    duplicates.append(title);continue
                seen_content.add(digest)
                rid=ulid('m')
                new_record={'id':rid,'type':typ,'topic':title,'title':title,'content':content}
                if typ in RULE_TYPES:new_record.update({'rule_key':rule_key,'status':'active'})
                if project_id is not None:new_record['project_id']=project_id
                if sources:new_record['source_record_ids']=sources
                if targets:new_record['supersedes']=[r['id'] for r,_ in targets]
                for previous,reason in targets:
                    expect(previous['id'] not in superseded_ids,'同一旧规则不能在本次计划中被重复替代')
                    superseded_ids.add(previous['id'])
                    supersede.append({'id':previous['id'],'date':previous['date'],'topic':previous['topic'],
                                      'content':previous['content'],'rule_key':previous['rule_key'],
                                      'source_project':previous.get('project_id'),
                                      'superseded_by':rid,'reason':reason})
                out.append(new_record)
            expect(out,('候选与已有记录完全重复，未写入：'+'、'.join(duplicates)) if duplicates else '没有可保存的候选记录')
            withdrawn=[date[:7]] if conn.execute('SELECT 1 FROM summaries WHERE month=?',(date[:7],)).fetchone() else []
            payload={'date':date,'saved_at':saved_at,'session_id':session_id,
                     'agent':candidate_check(data.get('agent','unknown'),True),
                     'records':out,'supersede':supersede,'withdrawn_months':withdrawn}
        elif op=='delete':
            ids=record_refs(data,'ids');expect(ids,'删除 ID 不能为空')
            expect(all(x in existing_ids for x in ids),'目标记忆 ID 不存在')
            doomed=set(ids);affected=[]
            for r in records:
                if r['id'] in doomed:continue
                removed_sources=[v for v in r.get('source_record_ids',[]) if v in doomed]
                removed_supersedes=[v for v in r.get('supersedes',[]) if v in doomed]
                removed_successor=r.get('superseded_by') if r.get('superseded_by') in doomed else None
                if removed_sources or removed_supersedes or removed_successor:
                    affected.append({'id':r['id'],'date':r['date'],'topic':r['topic'],'content':r['content'],
                                     'removed_source_record_ids':removed_sources,
                                     'removed_supersedes':removed_supersedes,
                                     'removed_superseded_by':removed_successor})
            affected_profiles=[p for p in profile_rows(conn) if doomed.intersection(p.get('source_record_ids',[]))]
            months={existing_ids[rid]['date'][:7] for rid in ids}
            withdrawn=[m for m in sorted(months)
                       if conn.execute('SELECT 1 FROM summaries WHERE month=?',(m,)).fetchone()]
            state=access_summary(conn)
            payload={'records':[{k:existing_ids[rid].get(k) for k in ('id','date','project_id','type','topic','content')} for rid in ids],
                     'affected_record_references':affected,'affected_profiles':affected_profiles,
                     'withdrawn_months':withdrawn,
                     'access_statistics':{'storage':'database','target_ids':ids,
                         'observed':[{'id':rid,**access_metrics(state['records'].get(rid))} for rid in ids],
                         'note':'删除目标在提交时的全部对应统计；计划生成到提交之间新增的目标访问同属此范围，不删除其他记录统计。'}}
        elif op=='profile':
            domain=data['domain'];expect(domain in DOMAINS,'非法画像领域')
            scope=data['scope'];expect(scope in ('global','domain:'+domain),'新增画像仅接受 global 或所选领域作用域')
            basis=data['basis'];expect(basis in ('explicit','inferred_confirmed'),'非法画像依据')
            sources=record_refs(data,'source_record_ids');expect(set(sources).issubset(existing_ids),'未知画像来源')
            replace_ids=record_refs(data,'replace_profile_ids');available=profile_rows(conn)
            expect(all(any(p['id']==v and p['domain']==domain for p in available) for v in replace_ids),
                   '画像替换目标不存在或不同领域')
            payload={'domain':domain,'profile':{'id':ulid('p'),'scope':scope,'basis':basis,'source_record_ids':sources,
                     'title':candidate_check(data['title'],True),'content':candidate_check(data['content'])},
                     'replace_ids':replace_ids,
                     'replaced_profiles':[p for p in available if p['id'] in replace_ids]}
        elif op=='month':
            month=parse_month(data['month']);month_closed(month,zone,data.get('closed_today_confirmed',False))
            now=dt.datetime.now(zone)
            exists=conn.execute('SELECT 1 FROM summaries WHERE month=?',(month,)).fetchone() is not None
            expect(not exists or data.get('rebuild_existing') is True,'已有正式摘要；明确指定重建才可覆盖')
            month_records=[r for r in records if r['date'][:7]==month];refmap={r['id']:r for r in month_records}
            topics=data['topics'];expect(isinstance(topics,list) and topics,'摘要不能是空内容')
            for topic in topics:
                expect(isinstance(topic,dict) and not set(topic)-{'title','content','source_record_ids'},'月度主题字段无效')
                candidate_check(topic['title'],True);candidate_check(topic['content'])
                refs=record_refs(topic,'source_record_ids')
                expect(refs and all(rid in refmap for rid in refs),'摘要来源必须属于指定月份')
            covered={rid for topic in topics for rid in topic['source_record_ids']}
            payload={'month':month,'topics':topics,'generated_at':now.isoformat(timespec='seconds'),
                     'closed_today_confirmed':data.get('closed_today_confirmed',False),
                     'source_total':len(month_records),'source_used':len(covered),
                     'source_uncovered_ids':sorted(set(refmap)-covered)}
        else: raise MemoryError('不支持的计划操作')
        expected=change_seq(conn)
    return plan_saved(root,op,payload,expected)


def plan_saved(root: Path, operation: str, payload: dict, expected: int) -> dict:
    # 只清理过期计划，不借生成新计划删除权威记忆。
    plan={'plan_version':PLAN_VERSION,'memory_scope':'global','plan_id':ulid('s'),'operation':operation,
          'created_at':time.time(),'expected_change_seq':expected,'payload':payload}
    with connect(root,write=True) as conn:
        require_version(conn)
        with transaction(conn):
            conn.execute('DELETE FROM plans WHERE created_at<?',(time.time()-24*3600,))
            conn.execute('INSERT INTO plans(plan_id,operation,plan_version,created_at,expected_change_seq,payload) '
                         'VALUES(?,?,?,?,?,?)',
                         (plan['plan_id'],operation,PLAN_VERSION,plan['created_at'],expected,compact(payload)))
    return plan


def plan_show(root: Path, plan_id: str) -> dict:
    expect(isinstance(plan_id,str) and plan_id.startswith('s_') and ID_RE.fullmatch(plan_id) is not None,'非法计划 ID')
    with connect(root) as conn:
        require_version(conn)
        row=conn.execute('SELECT plan_version,operation,created_at,expected_change_seq,payload FROM plans WHERE plan_id=?',
                         (plan_id,)).fetchone()
        expect(row is not None,'计划不存在/已提交')
        return {'plan_version':row['plan_version'],'memory_scope':'global','plan_id':plan_id,
                'operation':row['operation'],'created_at':row['created_at'],
                'expected_change_seq':row['expected_change_seq'],'payload':json.loads(row['payload'])}


def render_preview(plan: dict) -> dict:
    op=plan['operation'];d=plan['payload']
    result={'plan_version':plan['plan_version'],'memory_scope':'global','plan_id':plan['plan_id'],
            'operation':op,'expires_in_hours':24}
    if op=='save':
        result.update({'date':d['date'],'new_records':d['records'],
                       'superseded_records':d['supersede'],'history_preserved':True})
    elif op=='delete':
        result.update({'delete_records':d['records'],'affected_record_references':d['affected_record_references'],
                       'affected_profiles':d['affected_profiles'],
                       'affected_access_statistics':d['access_statistics']})
    elif op=='profile':
        result.update({'new_profile':d['profile'],'replace_profile_ids':d['replace_ids'],
                       'replaced_profiles':d['replaced_profiles'],'source_diary_preserved':True})
    elif op=='month':
        result.update({'month':d['month'],'summary':d['topics'],'source_total':d['source_total'],
                       'source_used':d['source_used'],'source_uncovered_ids':d['source_uncovered_ids']})
    if op in ('save','delete'): result['withdrawn_months']=d['withdrawn_months']
    if op=='month': result['preview_source_total']=d['source_total']
    return result


def commit(root: Path, plan_id: str) -> dict:
    expect(isinstance(plan_id,str) and plan_id.startswith('s_') and ID_RE.fullmatch(plan_id) is not None,'非法计划 ID')
    new_ids: list[str] = []
    with connect(root,write=True) as conn:
        require_version(conn)
        zone=timezone_of(conn)
        with transaction(conn):
            row=conn.execute('SELECT plan_version,operation,created_at,expected_change_seq,payload FROM plans WHERE plan_id=?',
                             (plan_id,)).fetchone()
            expect(row is not None,'计划不存在/已提交')
            expect(row['plan_version']==PLAN_VERSION,'PLAN_VERSION：旧语义计划不能提交，必须重新生成并确认')
            expect(time.time()-row['created_at']<=24*3600,'计划已过期')
            expect(row['expected_change_seq']==change_seq(conn),'STALE_PLAN：记忆库内容已经变化，必须重新预览')
            op=row['operation'];data=json.loads(row['payload'])
            if op=='month': month_closed(data['month'],zone,data.get('closed_today_confirmed',False))
            withdrawn=[];deleted_statistics=[]
            if op=='save':
                successors={r['id']:r['superseded_by'] for r in data['supersede']}
                for old_id,new_id in successors.items():
                    conn.execute('UPDATE records SET status=?,superseded_by=? WHERE id=?',('superseded',new_id,old_id))
                for r in data['records']:
                    terms,length=document_terms(r['title'],r['content'],r.get('rule_key'))
                    conn.execute('INSERT INTO records(id,date,session_id,agent,saved_at,type,topic,title,content,'
                                 'rule_key,status,superseded_by,project_id,content_digest,doc_length) '
                                 'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                                 (r['id'],data['date'],data['session_id'],data['agent'],data['saved_at'],r['type'],
                                  r['topic'],r['title'],r['content'],r.get('rule_key'),r.get('status','active'),
                                  None,r.get('project_id'),
                                  content_key(r['type'],r.get('rule_key'),r['title'],r['content']),length))
                    conn.executemany('INSERT INTO record_sources(record_id,source_id) VALUES(?,?)',
                                     [(r['id'],sid) for sid in r.get('source_record_ids',[])])
                    conn.executemany('INSERT INTO record_supersedes(record_id,target_id) VALUES(?,?)',
                                     [(r['id'],tid) for tid in r.get('supersedes',[])])
                    write_terms(conn,r['id'],terms)
                new_ids=[r['id'] for r in data['records']]
                withdrawn=data['withdrawn_months']
                for month in withdrawn: withdraw_month(conn,month)
            elif op=='delete':
                deleted={r['id'] for r in data['records']}
                access_plan=data.get('access_statistics')
                expect(isinstance(access_plan,dict) and access_plan.get('storage')=='database'
                       and isinstance(access_plan.get('target_ids'),list)
                       and len(access_plan['target_ids'])==len(deleted)
                       and set(access_plan['target_ids'])==deleted,
                       'PLAN_VERSION：删除计划未完整展示访问统计范围，须重新生成并确认')
                placeholders=_placeholders(sorted(deleted));ids=sorted(deleted)
                deleted_statistics=sorted({row[0] for row in conn.execute(
                    f'SELECT record_id FROM access_events WHERE record_id IN ({placeholders})',ids)})
                conn.execute(f'DELETE FROM access_events WHERE record_id IN ({placeholders})',ids)
                conn.execute(f'DELETE FROM record_sources WHERE source_id IN ({placeholders})',ids)
                conn.execute(f'DELETE FROM record_supersedes WHERE target_id IN ({placeholders})',ids)
                conn.execute(f'DELETE FROM profile_sources WHERE source_id IN ({placeholders})',ids)
                conn.execute(f'UPDATE records SET superseded_by=NULL WHERE superseded_by IN ({placeholders})',ids)
                conn.execute(f'DELETE FROM records WHERE id IN ({placeholders})',ids)
                withdrawn=data['withdrawn_months']
                for month in withdrawn: withdraw_month(conn,month)
            elif op=='profile':
                for pid in data['replace_ids']:
                    conn.execute('DELETE FROM profiles WHERE id=?',(pid,))
                profile=data['profile']
                conn.execute('INSERT INTO profiles(id,domain,scope,basis,title,content) VALUES(?,?,?,?,?,?)',
                             (profile['id'],data['domain'],profile['scope'],profile['basis'],
                              profile['title'],profile['content']))
                conn.executemany('INSERT INTO profile_sources(profile_id,source_id) VALUES(?,?)',
                                 [(profile['id'],sid) for sid in profile['source_record_ids']])
            elif op=='month':
                month=data['month'];withdraw_month(conn,month)
                for position,topic in enumerate(data['topics']):
                    terms,length=summary_terms(topic['title'],topic['content'])
                    conn.execute('INSERT INTO summaries(month,position,topic,content,generated_at,doc_length) '
                                 'VALUES(?,?,?,?,?,?)',
                                 (month,position,topic['title'],topic['content'],data['generated_at'],length))
                    conn.executemany('INSERT INTO summary_sources(month,position,source_id) VALUES(?,?,?)',
                                     [(month,position,sid) for sid in topic['source_record_ids']])
                    write_summary_terms(conn,month,position,terms)
            else: raise MemoryError('不支持的全局记忆计划操作')
            conn.execute('DELETE FROM plans WHERE plan_id=?',(plan_id,))
            version=bump(conn)
    return {'memory_scope':'global','committed':plan_id,'operation':op,'store_version':version,
            'new_record_ids':new_ids,'withdrawn_months':withdrawn,
            'deleted_access_statistics_ids':deleted_statistics,
            'superseded_record_ids':[r['id'] for r in data['supersede']] if op=='save' else []}


# ---------------------------------------------------------------------------
# 维护：状态、校验、重建、迁移、导出
# ---------------------------------------------------------------------------

def status_view(root: Path) -> dict:
    with connect(root) as conn:
        version=require_version(conn)
        return {'memory_scope':'global','root':str(root),'database':str(db_path(root)),
                'store_version':version,'change_seq':change_seq(conn),
                'timezone':meta_value(conn,'timezone'),'recent_window_days':recent_window(conn),
                'search':meta_value(conn,'search'),
                'records':conn.execute('SELECT COUNT(*) FROM records').fetchone()[0],
                'profiles':conn.execute('SELECT COUNT(*) FROM profiles').fetchone()[0],
                'summary_months':len({row[0] for row in conn.execute('SELECT DISTINCT month FROM summaries')}),
                'access_statistics':access_status(root)}


def integrity_view(root: Path) -> dict:
    with connect(root) as conn:
        require_version(conn)
        check=conn.execute('PRAGMA quick_check').fetchone()[0]
        expect(check=='ok',f'DB_CORRUPT：完整性检查失败：{check}')
        recs,profiles=validate_state(conn)
        for row in conn.execute('SELECT id,doc_length FROM records'):
            total=conn.execute('SELECT COALESCE(SUM(tf),0) FROM record_terms WHERE record_id=?',(row[0],)).fetchone()[0]
            expect(total==row[1],f'DB_INVALID：词项长度与记录不一致: {row[0]}')
        for row in conn.execute('SELECT month,position,doc_length FROM summaries'):
            total=conn.execute('SELECT COALESCE(SUM(tf),0) FROM summary_terms WHERE month=? AND position=?',
                               (row[0],row[1])).fetchone()[0]
            expect(total==row[2],f'DB_INVALID：词项长度与摘要不一致: {row[0]}#{row[1]}')
        expected_seq=conn.execute('SELECT COALESCE(MAX(rowid),0) FROM records').fetchone()[0]
        return {'valid':True,'records':len(recs),'profiles':len(profiles),'quick_check':check,
                'change_seq':change_seq(conn),'max_record_rowid':expected_seq}


def reindex_view(root: Path) -> dict:
    """重建只重算派生词项，不改写任何权威正文。"""
    with connect(root,write=True) as conn:
        require_version(conn)
        with transaction(conn):
            conn.execute('DELETE FROM record_terms')
            for row in conn.execute('SELECT id,title,content,rule_key FROM records'):
                terms,length=document_terms(row['title'],row['content'],row['rule_key'])
                write_terms(conn,row['id'],terms)
                conn.execute('UPDATE records SET doc_length=? WHERE id=?',(length,row['id']))
            conn.execute('DELETE FROM summary_terms')
            for row in conn.execute('SELECT month,position,topic,content FROM summaries'):
                terms,length=summary_terms(row['topic'],row['content'])
                write_summary_terms(conn,row['month'],row['position'],terms)
                conn.execute('UPDATE summaries SET doc_length=? WHERE month=? AND position=?',
                             (length,row['month'],row['position']))
            version=bump(conn)
    return {'reindexed':True,'store_version':version}


def reassign_store(root: Path, source: str, target: str) -> dict:
    """改判记录归属：只在目标归属下没有同键有效规则时搬移，保留记录、替代链与历史来源。"""
    for value in (source,target):
        expect(isinstance(value,str) and PROJECT_ID_RE.fullmatch(value) is not None,
               '项目归属必须是项目注册表的 UUID')
    expect(source!=target,'源与目标项目归属相同')
    with connect(root,write=True) as conn:
        require_version(conn)
        with transaction(conn):
            total=conn.execute('SELECT COUNT(*) FROM records WHERE project_id=?',(source,)).fetchone()[0]
            expect(total>0,f'没有归属 {source} 的记录')
            # 同键冲突不自动裁决：两个归属各自的有效规则合并后会变成重复有效版本。
            conflicts=[row[0] for row in conn.execute(
                'SELECT s.id FROM records s JOIN records t ON t.project_id=? AND t.rule_key=s.rule_key '
                'AND t.status=? WHERE s.project_id=? AND s.status=? AND s.type IN (?,?)',
                (target,'active',source,'active',*sorted(RULE_TYPES)))]
            expect(not conflicts,'目标归属下已有同键有效规则，需先决定替代顺序: '+','.join(conflicts))
            conn.execute('UPDATE records SET project_id=? WHERE project_id=?',(target,source))
            version=bump(conn)
    return {'reassigned':total,'from':source,'to':target,'store_version':version}


def init_store(root: Path, timezone: str) -> dict:
    expect(not root.exists() or not any(root.iterdir()),'目标目录非空，禁止覆盖')
    result=create_store(root,timezone)
    return {'initialized':str(root),**result}


def migrate_store(target: Path, source: Path) -> dict:
    """一次性把旧 Markdown 库导入 SQLite：先归档原名，失败回滚改名，成功才写库。"""
    source=source.absolute();target=target.absolute()
    expect(source.is_dir() and not source.is_symlink(),'旧库目录不存在或不是普通目录')
    manifest_path=source/'manifest.json'
    expect(manifest_path.is_file(),'旧库缺少 manifest.json，无法迁移')
    manifest=json.loads(manifest_path.read_text(encoding='utf-8'))
    expect(manifest.get('schema_version') in LEGACY_SCHEMAS,
           f'旧库版本不支持迁移: {manifest.get("schema_version")}')
    timezone=str(manifest.get('timezone'))
    expect(timezone,'旧库缺少时区，无法迁移')
    expect(not db_path(target).exists(),'DB_EXISTS：目标库已存在，禁止迁移覆盖')
    expect(target==source or not target.exists() or not any(target.iterdir()),
           '迁移目标目录非空，禁止覆盖')
    records=_legacy_records(source)
    profiles=_legacy_profiles(source)
    summaries=_legacy_summaries(source,{r['id'] for r in records})
    access=_legacy_access(source)
    stamp=dt.datetime.now().strftime('%Y%m%dT%H%M%S')
    archive=source.parent/(source.name+'-archive-'+stamp)
    expect(not archive.exists(),f'归档目录已存在: {archive}')
    moved=source!=target
    if moved:
        source.rename(archive)
        target.mkdir(parents=True,exist_ok=True)
    else:
        archive.mkdir(parents=True,exist_ok=False)
        for entry in source.iterdir():
            entry.rename(archive/entry.name)
    try:
        create_store(target,timezone)
        with connect(target,write=True) as conn:
            with transaction(conn):
                conn.execute('DELETE FROM meta')
                meta_patch(conn,{'timezone':timezone,
                                 'recent_window_days':int(manifest.get('recent_window_days',DEFAULT_RECENT_WINDOW)),
                                 'change_seq':0,'created_at':dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
                                 'storage':'sqlite','search':SEARCH_ALGORITHM})
                for record in records:
                    terms,length=document_terms(record['title'],record['content'],record.get('rule_key'))
                    conn.execute('INSERT INTO records(id,date,session_id,agent,saved_at,type,topic,title,content,'
                                 'rule_key,status,superseded_by,project_id,content_digest,doc_length) '
                                 'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                                 (record['id'],record['date'],record['session']['id'],record['session']['agent'],
                                  record['session']['saved_at'],record['type'],record['topic'],record['title'],
                                  record['content'],record.get('rule_key'),record.get('status','active'),
                                  record.get('superseded_by'),record.get('project_id'),
                                  content_key(record['type'],record.get('rule_key'),record['title'],record['content']),
                                  length))
                    write_terms(conn,record['id'],terms)
                    conn.executemany('INSERT INTO record_sources(record_id,source_id) VALUES(?,?)',
                                     [(record['id'],sid) for sid in record.get('source_record_ids',[])])
                    conn.executemany('INSERT INTO record_supersedes(record_id,target_id) VALUES(?,?)',
                                     [(record['id'],tid) for tid in record.get('supersedes',[])])
                for profile in profiles:
                    conn.execute('INSERT INTO profiles(id,domain,scope,basis,title,content) VALUES(?,?,?,?,?,?)',
                                 (profile['id'],profile['domain'],profile['scope'],profile['basis'],
                                  profile['title'],profile['content']))
                    conn.executemany('INSERT INTO profile_sources(profile_id,source_id) VALUES(?,?)',
                                     [(profile['id'],sid) for sid in profile.get('source_record_ids',[])])
                for position,summary in enumerate(summaries):
                    terms,length=summary_terms(summary['topic'],summary['content'])
                    conn.execute('INSERT INTO summaries(month,position,topic,content,generated_at,doc_length) '
                                 'VALUES(?,?,?,?,?,?)',
                                 (summary['month'],summary['position'],summary['topic'],summary['content'],
                                  summary['generated_at'],length))
                    conn.executemany('INSERT INTO summary_sources(month,position,source_id) VALUES(?,?,?)',
                                     [(summary['month'],summary['position'],sid) for sid in summary['source_record_ids']])
                    write_summary_terms(conn,summary['month'],summary['position'],terms)
                if access['started_at']:
                    meta_patch(conn,{'access_started_at':access['started_at']})
                    for rid,rows in access['events'].items():
                        conn.executemany('INSERT INTO access_events(record_id,session_hash,event_hash,at) VALUES(?,?,?,?)',
                                         [(rid,session,event,at) for session,event,at in rows])
                version=bump(conn)
        imported=status_view(target)
        expect(imported['records']==len(records),'迁移校验失败：记录数量不一致')
        expect(imported['profiles']==len(profiles),'迁移校验失败：画像数量不一致')
        expect(imported['summary_months']==len({s['month'] for s in summaries}),'迁移校验失败：摘要月份不一致')
    except BaseException:
        db=db_path(target)
        if db.exists(): db.unlink()
        for suffix in ('-wal','-shm'):
            extra=db.with_name(db.name+suffix)
            if extra.exists(): extra.unlink()
        if moved:
            if target.exists() and not any(target.iterdir()): target.rmdir()
            archive.rename(source)
        else:
            for entry in archive.iterdir(): entry.rename(source/entry.name)
            archive.rmdir()
        raise
    return {'migrated':True,'database':str(db_path(target)),'archive':str(archive),
            'store_version':STORE_VERSION,'records':len(records),'profiles':len(profiles),
            'summaries':len(summaries),'access_records':len(access['events']),'change_seq':version}


def export_store(root: Path, out: Path) -> dict:
    """生成只读 Markdown 快照供人阅读；导出物不参与写回，也不被引擎读取。"""
    expect(not out.exists() or not any(out.iterdir()),'导出目标非空，禁止覆盖')
    with connect(root) as conn:
        require_version(conn)
        records=record_rows(conn)
        profiles=profile_rows(conn)
        summaries=summary_rows(conn)
    out.mkdir(parents=True,exist_ok=True)
    by_date={}
    for record in records: by_date.setdefault(record['date'],[]).append(record)
    for date,rows in sorted(by_date.items()):
        path=out/'daily'/date[:4]/date[5:7]/(date+'.md')
        path.parent.mkdir(parents=True,exist_ok=True)
        atomic_write(path,render_daily(date,rows).encode())
    for month in sorted({row['month'] for row in summaries}):
        path=out/'monthly'/month[:4]/(month+'.md')
        path.parent.mkdir(parents=True,exist_ok=True)
        atomic_write(path,render_monthly(month,[row for row in summaries if row['month']==month],
                                         next(row['generated_at'] for row in summaries if row['month']==month)).encode())
    for domain in sorted({row['domain'] for row in profiles} | DOMAINS):
        path=out/'profile'/(domain+'.md')
        path.parent.mkdir(parents=True,exist_ok=True)
        atomic_write(path,render_profiles(domain,[row for row in profiles if row['domain']==domain]).encode())
    atomic_write(out/'manifest.json',j({'schema_version':'0.3','timezone':meta_of(root),
                                         'recent_window_days':30,'exported_from':'sqlite'}).encode())
    return {'exported':str(out),'records':len(records),'profiles':len(profiles),
            'summaries':len(summaries),'note':'只读快照；不参与写回，引擎不再读取这些文件'}


def meta_of(root: Path) -> str:
    with connect(root) as conn:
        return meta_value(conn,'timezone')


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True,exist_ok=True)
    tmp=path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp')
    with open(tmp,'wb') as f:
        f.write(data);f.flush()
    tmp.replace(path)


def render_daily(date: str, records: list[dict]) -> str:
    out=[f'---\nschema_version: "0.3"\ndate: "{date}"\n---\n\n# {date}\n',
         '## 全局记忆\n'+LEGACY_GLOBAL_OPEN+'\n']
    for session_id in dict.fromkeys(record['session']['id'] for record in records):
        rows=[record for record in records if record['session']['id']==session_id]
        session=rows[0]['session']
        out.append(f'### 会话 {session["saved_at"][11:16]}\n<!-- memory:session {compact(session)} -->\n')
        for row in rows:
            meta={key:row[key] for key in ('id','type','topic','rule_key','status','superseded_by','project_id')
                  if row.get(key) is not None}
            if row['source_record_ids']: meta['source_record_ids']=row['source_record_ids']
            if row['supersedes']: meta['supersedes']=row['supersedes']
            out.append(f'<!-- memory:record {compact(meta)} -->\n#### {row["title"]}\n{row["content"]}\n<!-- /memory:record -->\n')
    return '\n'.join(out).rstrip()+'\n'


def render_monthly(month: str, rows: list[dict], generated_at: str) -> str:
    out=[f'---\nschema_version: "0.3"\nmonth: "{month}"\ngenerated_at: "{generated_at}"\n---\n\n# {month} 工作回顾\n',
         '## 全局回顾\n'+LEGACY_GLOBAL_OPEN+'\n']
    for row in rows:
        meta={'source_record_ids':row['source_record_ids']}
        out.append(f'### {row["topic"]}\n<!-- memory:summary {compact(meta)} -->\n{row["content"]}\n<!-- /memory:summary -->\n')
    return '\n'.join(out).rstrip()+'\n'


def render_profiles(domain: str, rows: list[dict]) -> str:
    out=[f'# {domain}\n']
    for row in rows:
        meta={key:row[key] for key in ('id','scope','basis','source_record_ids')}
        out.append(f'<!-- memory:profile {compact(meta)} -->\n## {row["title"]}\n{row["content"]}\n<!-- /memory:profile -->\n')
    return '\n'.join(out).rstrip()+'\n'


# ---------------------------------------------------------------------------
# 旧 Markdown 库解析（仅 migrate 使用）
# ---------------------------------------------------------------------------

def _legacy_files(root: Path, subtree: str, suffix: str) -> list[str]:
    base=root/subtree
    if not base.is_dir(): return []
    out=[]
    for path in sorted(base.rglob('*')):
        expect(not path.is_symlink(),'禁止符号链接: '+str(path))
        if path.is_file() and path.suffix==suffix:
            out.append(path.relative_to(root).as_posix())
    return out


def _legacy_records(root: Path) -> list[dict]:
    found=[]
    for rel in _legacy_files(root,'daily','.md'):
        text=(root/rel).read_text(encoding='utf-8').replace('\r\n','\n')
        lines=text.splitlines();source={};current_session=None;scope_known=False;i=0
        while i<len(lines):
            line=lines[i]
            if line.startswith('## '):
                expect(i+1<len(lines),'记忆范围标记丢失')
                marker=lines[i+1]
                if marker==LEGACY_GLOBAL_OPEN: source={}
                else:
                    mt=LEGACY_PROJECT_OPEN.fullmatch(marker)
                    expect(mt is not None,'无法识别记忆范围标记')
                    pid=json.loads(mt.group(1))['id']
                    source={'project_id':pid,'project_name':line[3:]}
                scope_known=True;current_session=None;i+=2;continue
            if line.startswith('### '):
                expect(scope_known and i+1<len(lines),'会话缺少记忆范围上下文')
                mt=LEGACY_SESSION_OPEN.fullmatch(lines[i+1])
                expect(mt is not None,'会话标记丢失')
                current_session=json.loads(mt.group(1));i+=2;continue
            mt=LEGACY_RECORD_OPEN.fullmatch(line)
            if mt:
                expect(scope_known and current_session,'记录没有会话上下文')
                meta=json.loads(mt.group(1))
                expect(i+1<len(lines) and lines[i+1].startswith('#### '),'记录标题丢失')
                title=lines[i+1][5:];i+=2;body=[]
                while i<len(lines) and lines[i]!='<!-- /memory:record -->':body.append(lines[i]);i+=1
                expect(i<len(lines),'缺少记录结束标记')
                found.append({**source,**meta,'session':current_session,'title':title,
                              'content':'\n'.join(body).strip(),'date':Path(rel).stem})
            i+=1
    ids=[r['id'] for r in found]
    expect(len(ids)==len(set(ids)),'记忆 ID 在不同日期重复')
    for record in found:
        record.setdefault('status','active')
        record.pop('project_name',None)
        project=record.get('project_id')
        if project is not None and PROJECT_ID_RE.fullmatch(str(project)) is None: record.pop('project_id',None)
    return found


def _legacy_profiles(root: Path) -> list[dict]:
    result=[]
    for domain in sorted(DOMAINS):
        path=root/'profile'/(domain+'.md')
        if not path.is_file(): continue
        lines=path.read_text(encoding='utf-8').splitlines();i=0
        while i<len(lines):
            mt=LEGACY_PROFILE_OPEN.fullmatch(lines[i])
            if mt:
                meta=json.loads(mt.group(1))
                expect(i+1<len(lines) and lines[i+1].startswith('## '),'画像标题丢失')
                title=lines[i+1][3:];i+=2;body=[]
                while i<len(lines) and lines[i]!='<!-- /memory:profile -->':body.append(lines[i]);i+=1
                expect(i<len(lines),'画像缺少结束标记')
                result.append({**meta,'domain':domain,'title':title,'content':'\n'.join(body).strip()})
            i+=1
    ids=[p['id'] for p in result]
    expect(len(ids)==len(set(ids)),'画像 ID 重复')
    return result


def _legacy_summaries(root: Path, valid_ids: set[str]) -> list[dict]:
    result=[]
    for rel in _legacy_files(root,'monthly','.md'):
        month=Path(rel).stem
        lines=(root/rel).read_text(encoding='utf-8').splitlines();topic='';i=0;position=0
        while i<len(lines):
            line=lines[i]
            if line.startswith('### '): topic=line[4:]
            mt=LEGACY_SUM_OPEN.fullmatch(line)
            if mt:
                meta=json.loads(mt.group(1));body=[];i+=1
                while i<len(lines) and lines[i]!='<!-- /memory:summary -->':body.append(lines[i]);i+=1
                expect(i<len(lines),'月摘要缺少结束标记')
                ids=meta['source_record_ids']
                expect(set(ids).issubset(valid_ids),f'摘要来源已丢失: {rel}')
                result.append({'month':month,'position':position,'topic':topic,
                               'content':'\n'.join(body).strip(),
                               'generated_at':_legacy_generated_at(root/rel),'source_record_ids':ids})
                position+=1
            i+=1
    return result


def _legacy_generated_at(path: Path) -> str:
    for line in path.read_text(encoding='utf-8').splitlines()[:8]:
        mt=re.fullmatch(r'generated_at: "(.+)"',line)
        if mt: return mt.group(1)
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')


def _legacy_access(root: Path) -> dict:
    path=root/'.system'/'access.json'
    empty={'started_at':None,'events':{}}
    if not path.is_file(): return empty
    state=json.loads(path.read_text(encoding='utf-8'))
    expect(isinstance(state,dict) and isinstance(state.get('records'),dict),'ACCESS_INVALID：统计结构无效')
    events={}
    for rid,row in state['records'].items():
        expect(isinstance(row,dict) and isinstance(row.get('sessions'),dict),'ACCESS_INVALID：记录统计结构无效')
        at=row.get('last_read_at')
        access_time(at)
        rows=[]
        for session,items in row['sessions'].items():
            expect(isinstance(items,list),'ACCESS_INVALID：去重身份无效')
            for event in items: rows.append((session,event,at))
        if rows: events[rid]=rows
    return {'started_at':state.get('started_at'),'events':events}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser=argparse.ArgumentParser(description=__doc__)
    # 桌面受管环境用 -I 隔离运行，不能靠环境变量传时区路径；这里显式接收随包 IANA 目录。
    parser.add_argument('--tzdata',default=None,help='explicit IANA directory shipped with the app; default keeps system/tzdata behavior')
    parser.add_argument('--store',default=str(Path.home()/'.agents'/'memory-store'),help='memory-store directory (default: ~/.agents/memory-store; override only for tests/migration)')
    sub=parser.add_subparsers(dest='cmd',required=True)
    init=sub.add_parser('init');init.add_argument('--timezone',required=True)
    sub.add_parser('status');sub.add_parser('validate');sub.add_parser('integrity')
    sub.add_parser('reindex');sub.add_parser('months')
    rs=sub.add_parser('reassign');rs.add_argument('--from',dest='source',required=True)
    rs.add_argument('--to',dest='target',required=True);rs.add_argument('--approved',action='store_true')
    migrate=sub.add_parser('migrate');migrate.add_argument('--from',dest='source',default=None,
        help='legacy Markdown store directory (default: --store)')
    export=sub.add_parser('export');export.add_argument('--out',required=True)
    pp=sub.add_parser('plan');pp.add_argument('operation',choices=['save','delete','profile','month']);pp.add_argument('--input',required=True)
    ps=sub.add_parser('plan-show');ps.add_argument('--plan-id',required=True)
    cm=sub.add_parser('commit');cm.add_argument('--plan-id',required=True);cm.add_argument('--approved',action='store_true')
    sr=sub.add_parser('search');sr.add_argument('--query',default='');sr.add_argument('--month');sr.add_argument('--all-dates',action='store_true');sr.add_argument('--historical',action='store_true');sr.add_argument('--limit',type=int,default=50)
    recall=sub.add_parser('recall');recall.add_argument('--query',required=True);recall.add_argument('--mode',choices=['auto','records','recent','historical','month'],default='auto');recall.add_argument('--month');recall.add_argument('--project');recall.add_argument('--offset',type=int,default=0);recall.add_argument('--limit',type=int,default=50)
    background=sub.add_parser('recall-background');background.add_argument('--input',required=True,choices=['-'])
    error=sub.add_parser('error-recall');error.add_argument('--input',required=True,choices=['-'])
    rules=sub.add_parser('rules');rules.add_argument('--query',default='');rules.add_argument('--project');rules.add_argument('--offset',type=int,default=0);rules.add_argument('--limit',type=int,default=50)
    notes=sub.add_parser('project-notes');notes.add_argument('--project',required=True);notes.add_argument('--date-from',required=True);notes.add_argument('--limit',type=int,default=3)
    ms=sub.add_parser('month-source');ms.add_argument('month');ms.add_argument('--offset',type=int,default=0);ms.add_argument('--limit',type=int,default=50);ms.add_argument('--closed-today-confirmed',action='store_true')
    rr=sub.add_parser('read');rr.add_argument('ids',nargs='+')
    ac=sub.add_parser('access-record');ac.add_argument('--input',required=True,choices=['-'])
    ast=sub.add_parser('access-stats');ast.add_argument('ids',nargs='+')
    pr=sub.add_parser('profiles');pr.add_argument('--domain',choices=sorted(DOMAINS))
    args=parser.parse_args()
    if args.tzdata is not None:
        # 只接受现有目录，且不使用符号链接；数据缺失时保持默认行为而不是静默降级。
        tzpath=Path(args.tzdata)
        expect(tzpath.is_dir() and not tzpath.is_symlink(),'指定的 IANA 时区目录不存在或不是普通目录')
        expect((tzpath/'UTC').is_file(),'指定的 IANA 时区目录缺少 UTC 数据')
        zoneinfo.reset_tzpath([str(tzpath.absolute())])
    root=Path(args.store).expanduser().absolute()
    if args.cmd=='init':
        result=init_store(root,args.timezone)
    elif args.cmd=='migrate':
        result=migrate_store(root,Path(args.source).expanduser().absolute() if args.source else root)
    else:
        if args.cmd=='export':
            result=export_store(root,Path(args.out).expanduser().absolute())
        elif args.cmd=='plan-show':
            result=plan_show(root,args.plan_id)
        elif args.cmd=='plan':
            raw_input=json.loads(sys.stdin.buffer.read().decode('utf-8')) if args.input=='-' else json.loads(Path(args.input).read_text(encoding='utf-8'))
            result=render_preview(prepare(root,args.operation,raw_input))
        elif args.cmd=='commit':
            expect(args.approved,'必须明确 --approved；该标记只是引擎内部确认，不代表用户逐份批准')
            result=commit(root,args.plan_id)
        elif args.cmd=='status':
            result=status_view(root)
        elif args.cmd=='validate':
            with connect(root) as conn:
                require_version(conn)
                recs,profiles=validate_state(conn)
                result={'valid':True,'records':len(recs),'profiles':len(profiles)}
        elif args.cmd=='integrity':
            result=integrity_view(root)
        elif args.cmd=='reindex':
            result=reindex_view(root)
        elif args.cmd=='reassign':
            expect(args.approved,'改判记录归属必须先取得明确授权，再使用 --approved')
            result=reassign_store(root,args.source,args.target)
        elif args.cmd=='months':
            result=months_view(root)
        elif args.cmd=='recall':
            expect(not (args.mode=='auto' and args.month),'auto 模式不接受 --month；按月查询请用 --mode month')
            if args.mode=='auto':
                result=layered_recall(root,args.query,args.offset,args.limit,args.project)
            else:
                result=indexed_recall(root,args.query,args.mode,args.month,args.offset,args.limit,project=args.project)
        elif args.cmd=='recall-background':
            raw=sys.stdin.buffer.read(65_537)
            expect(len(raw)<=65_536,'自动召回输入超过上限')
            result=background_recall(root,json.loads(raw.decode('utf-8')))
        elif args.cmd=='error-recall':
            raw=sys.stdin.buffer.read(65_537)
            expect(len(raw)<=65_536,'报错召回输入超过上限')
            result=error_recall(root,json.loads(raw.decode('utf-8')))
        elif args.cmd=='search':
            expect(not (args.historical and (args.month or args.all_dates)),'--historical 不能与 --month/--all-dates 合用')
            expect(not (args.month and args.all_dates),'--month 不能与 --all-dates 合用')
            mode='historical' if args.historical else 'month' if args.month else 'records' if args.all_dates else 'recent'
            result=indexed_recall(root,args.query,mode,args.month,0,args.limit,allow_empty=True)
        elif args.cmd=='rules':
            result=active_rules(root,args.query,args.offset,args.limit,args.project)
        elif args.cmd=='project-notes':
            result=project_notes(root,args.project,args.date_from,args.limit)
        elif args.cmd=='month-source':
            result=monthly_source(root,args.month,args.offset,args.limit,args.closed_today_confirmed)
        elif args.cmd=='read':
            result=indexed_read(root,args.ids)
        elif args.cmd=='access-record':
            raw_input=json.loads(sys.stdin.buffer.read().decode('utf-8'))
            result=record_access(root,raw_input)
        elif args.cmd=='access-stats':
            result=indexed_access_stats(root,args.ids)
        elif args.cmd=='profiles':
            result=profiles_view(root,args.domain)
        else: raise MemoryError('未知操作')
    print(j({'ok':True,'data':result,'error':None}),end='')


if __name__=='__main__':
    if hasattr(sys.stdin,'reconfigure'):sys.stdin.reconfigure(encoding='utf-8')
    if hasattr(sys.stdout,'reconfigure'):sys.stdout.reconfigure(encoding='utf-8')
    try:main()
    except (MemoryError,ValueError,KeyError,TypeError,UnicodeError,json.JSONDecodeError,OSError,sqlite3.Error) as e:
        print(j({'ok':False,'data':None,'error':{'type':e.__class__.__name__,'message':str(e)}}),end='')
        sys.exit(1)
