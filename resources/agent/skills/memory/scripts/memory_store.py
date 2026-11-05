#!/usr/bin/env python3
"""用户级全局日记、画像与月度摘要文件引擎，不依赖当前项目或项目登记。

权威写入经过具体计划与确认，访问统计独立持久化。旧日记的来源标签仅作历史信息；
读取不自动迁移、改写旧正文、修复索引或把局部规则提升为通用要求。
"""
import argparse, contextlib, datetime as dt, hashlib, json, math, os, re, secrets, shutil, stat, sys, time, unicodedata, uuid
from collections import Counter
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
import zoneinfo

SCHEMA = '0.3'
TYPES = {'decision','constraint','progress','issue','fact','preference_evidence'}
RULE_TYPES = {'decision','constraint'}
PLAN_VERSION = 3
DOMAINS = {'communication','coding','learning','workflow'}
ALLOWED_TOP = {'manifest.json','catalog','daily','monthly','profile','index','.system'}
ID_RE = re.compile(r'^[msp]_[0-9A-HJKMNP-TV-Z]{26}$')
RECORD_OPEN = re.compile(r'^<!-- memory:record (\{.*\}) -->$')
PROJECT_OPEN = re.compile(r'^<!-- memory:project (\{.*\}) -->$')
GLOBAL_OPEN = '<!-- memory:global -->'
SESSION_OPEN = re.compile(r'^<!-- memory:session (\{.*\}) -->$')
PROFILE_OPEN = re.compile(r'^<!-- memory:profile (\{.*\}) -->$')
SUM_OPEN = re.compile(r'^<!-- memory:summary (\{.*\}) -->$')
SEARCH_INDEX = 'index/search.json'
SEARCH_VERSION = 1
SEARCH_ALGORITHM = 'cjk-bigram-bm25-v1'
ACCESS_STORE = '.system/access.json'
ACCESS_VERSION = 1
ACCESS_NOTE = '仅统计采集开始后的主动定向读取；不代表全部访问、模型接收、理解、采纳或事实正确，不参与检索排序。'
SEARCH_TOKENS = re.compile(r'[a-z0-9_]+|[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\U00020000-\U0002ebef]+')
SEARCH_STOPWORDS = {'的','了','是','在','和','与','我','你','如何','什么','怎么','一个','这个','那个',
                    'the','a','an','and','or','is','are','to','of','for','in','how','what'}

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
def read(p): return p.read_text(encoding='utf-8')
def parse_json(p): return json.loads(read(p))
def expect(condition, message):
    if not condition: raise MemoryError(message)

def safe(root, rel):
    rel=Path(rel)
    expect(not rel.is_absolute() and '..' not in rel.parts and len(rel.parts)>0,'非法路径')
    expect(rel.parts[0] in ALLOWED_TOP,'非白名单数据路径')
    p=root/rel
    parent=p
    while parent!=root.parent and parent!=root:
        expect(not parent.is_symlink(), '禁止通过符号链接读写数据')
        parent=parent.parent
    return p

def file_bytes(root, rel, overrides=None):
    if overrides is not None and rel in overrides: return overrides[rel]
    p=safe(root,rel)
    return p.read_bytes() if p.exists() else None

def stored_files(root, subtree, suffix):
    p=safe(root,subtree)
    if not p.exists(): return []
    out=[]
    for f in sorted(p.rglob('*')):
        if f.is_file() and f.suffix==suffix:
            expect(not f.is_symlink(), '禁止符号链接: '+str(f))
            out.append(f.relative_to(root).as_posix())
    return out

def root_fingerprint(root: Path) -> str:
    paths=['manifest.json']
    if file_bytes(root,'catalog/projects.json') is not None:paths.append('catalog/projects.json')
    for directory,ext in [('daily','.md'),('monthly','.md'),('profile','.md')]:paths+=stored_files(root,directory,ext)
    return sha(compact([[s,sha(file_bytes(root,s))] for s in sorted(paths)]).encode())

def load(root: Path) -> tuple[dict,dt.tzinfo]:
    expect(root.is_dir(),f'记忆库不存在: {root}；先执行 init')
    expect(not root.is_symlink(),'记忆库根目录不能是符号链接')
    manifest=parse_json(safe(root,'manifest.json'))
    expect(manifest.get('schema_version') in ('0.2',SCHEMA),'数据版本不匹配；未自动迁移')
    zone=manifest.get('timezone')
    try: z=ZoneInfo(zone)
    except (ZoneInfoNotFoundError,TypeError): raise MemoryError(f'无效/不可用的 IANA 时区: {zone}；Windows 可能需要安装 tzdata')
    return manifest,z

def require_clean_transactions(root: Path) -> None:
    """普通操作不得以查询或生成计划为由自动回滚权威数据。"""
    pending=safe(root,'.system/transactions')
    expect(not pending.exists() or not any(pending.iterdir()),
           'RECOVERY_REQUIRED：存在未处理事务；须单独批准 recover --approved')

@contextlib.contextmanager
def locking(root,exclusive=False,allow_recovery=False,blocking=True,existing_only=False):
    lock=safe(root,'.system/lock')
    if exclusive and not existing_only:
        lock.parent.mkdir(parents=True,exist_ok=True)
    else:
        expect(lock.is_file(),'锁文件缺失；此操作不会自动创建技术文件')
    with open(lock,'a+b' if exclusive and not existing_only else 'r+b') as f:
        if os.name=='nt':
            import msvcrt
            f.seek(0)
            while True:
                try:
                    msvcrt.locking(f.fileno(),msvcrt.LK_LOCK if blocking else msvcrt.LK_NBLCK,1);break
                except OSError:
                    if not blocking:raise MemoryError('ACCESS_BUSY：记忆库正在操作，未写入访问统计')
                    time.sleep(.05)
        else:
            import fcntl
            flags=fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
            try:fcntl.flock(f.fileno(),flags | (0 if blocking else fcntl.LOCK_NB))
            except BlockingIOError:raise MemoryError('ACCESS_BUSY：记忆库正在操作，未写入访问统计')
        try:
            if not allow_recovery:require_clean_transactions(root)
            yield
        finally:
            if os.name=='nt':f.seek(0);msvcrt.locking(f.fileno(),msvcrt.LK_UNLCK,1)
            else:fcntl.flock(f.fileno(),fcntl.LOCK_UN)

def atomic_write(p, data):
    p.parent.mkdir(parents=True,exist_ok=True)
    tmp=p.with_name(p.name+'.'+uuid.uuid4().hex+'.tmp')
    with open(tmp,'wb') as f: f.write(data); f.flush();os.fsync(f.fileno())
    os.replace(tmp,p)

def apply_transaction(root,changes):
    """Multi-file rollback journal. All cooperating readers/writers must take lock."""
    if not changes:return
    txid='tx_'+uuid.uuid4().hex
    base=safe(root,'.system/transactions')/txid
    base.mkdir(parents=True)
    entries=[]
    for i,(rel,new) in enumerate(sorted(changes.items())):
        expect(rel==ACCESS_STORE or rel.startswith(('daily/','monthly/','profile/','catalog/','index/')),
               '不允许事务修改此位置')
        old=file_bytes(root,rel)
        expect(new is None or isinstance(new,bytes),'新文件必须是 bytes 或 None')
        if old is not None:atomic_write(base/f'old_{i}',old)
        if new is not None:atomic_write(base/f'new_{i}',new)
        entries.append({'path':rel,'old':sha(old) if old is not None else None,'new':sha(new) if new is not None else None,'n':i})
    journal={'state':'PREPARED','files':entries}
    atomic_write(base/'journal.json',j(journal).encode())
    try:
        for x in entries:
            p=safe(root,x['path'])
            if x['new'] is None:
                p.unlink(missing_ok=True)
            else:atomic_write(p,(base/f"new_{x['n']}").read_bytes())
        journal['state']='COMMITTED'
        atomic_write(base/'journal.json',j(journal).encode())
    except Exception:
        # 保留日志；后续普通操作须停止，只有单独获批的恢复操作可处理事务。
        raise
    shutil.rmtree(base)

def recover(root):
    pending=safe(root,'.system/transactions')
    if not pending.exists():return
    for base in sorted(pending.iterdir()):
        expect(base.is_dir() and not base.is_symlink(),'非法事务目录')
        jp=base/'journal.json'
        expect(jp.exists(),'事务暂存损坏，请人工检查 '+str(base))
        journal=parse_json(jp)
        if journal['state']=='COMMITTED':shutil.rmtree(base);continue
        for x in reversed(journal['files']):
            p=safe(root,x['path']); current=p.read_bytes() if p.exists() else None
            digest=sha(current) if current is not None else None
            expect(digest in (x['old'],x['new']),f'文件被外部修改，禁止自动回滚: {p}')
            if x['old'] is None:p.unlink(missing_ok=True)
            else:atomic_write(p,(base/f"old_{x['n']}").read_bytes())
        shutil.rmtree(base)

def candidate_check(text, single_line=False):
    expect(isinstance(text,str) and text.strip(),'文本不能为空')
    expect('<!-- memory:' not in text and '<!-- /memory:' not in text,'文本包含保留标记')
    if single_line: expect('\n' not in text and '\r' not in text and '<!--' not in text, '标题或项目名称必须为单行且不能含标记')
    return text.strip()

def parse_daily(text: str) -> list[dict]:
    """同时读取全局段与旧来源段；旧标签不参与项目身份绑定。"""
    text=text.replace('\r\n','\n')
    lines=text.splitlines();recs=[];source={};current_session=None;scope_known=False;i=0
    expect(text.startswith('---\n') and '\n# ' in text,'非法每日记忆文件头')
    while i<len(lines):
        line=lines[i]
        if line.startswith('## '):
            expect(i+1<len(lines),'记忆范围标记丢失')
            marker=lines[i+1]
            if marker==GLOBAL_OPEN:source={}
            else:
                mt=PROJECT_OPEN.fullmatch(marker);expect(mt,'无法识别记忆范围标记')
                pid=json.loads(mt.group(1))['id']
                expect(isinstance(pid,str) and bool(pid),'历史来源标签无效')
                source={'project_id':pid,'project_name':line[3:]}
            scope_known=True;current_session=None;i+=2;continue
        if line.startswith('### '):
            expect(scope_known and i+1<len(lines),'会话缺少记忆范围上下文')
            mt=SESSION_OPEN.fullmatch(lines[i+1]);expect(mt,'会话标记丢失')
            current_session=json.loads(mt.group(1));i+=2;continue
        mt=RECORD_OPEN.fullmatch(line)
        if mt:
            expect(scope_known and current_session,'记录没有会话上下文')
            meta=json.loads(mt.group(1));expect(i+1<len(lines) and lines[i+1].startswith('#### '),'记录标题丢失')
            title=lines[i+1][5:];i+=2;body=[]
            while i<len(lines) and lines[i]!='<!-- /memory:record -->':body.append(lines[i]);i+=1
            expect(i<len(lines),'缺少记录结束标记')
            recs.append({**meta,**source,'session':current_session,'title':title,'content':'\n'.join(body).strip()})
            i+=1;continue
        if line.startswith('<!-- memory:') or line.startswith('<!-- /memory:'):
            raise MemoryError('未识别的记录标记: '+line)
        i+=1
    ids=[r['id'] for r in recs]
    expect(len(set(ids))==len(ids),'每日文件内记忆 ID 重复')
    return recs

def render_daily(date: str, recs: list[dict]) -> str:
    """新增内容写入全局段；获批改写同日文件时保留旧记录的来源分组。"""
    out=[f'---\nschema_version: "{SCHEMA}"\ndate: "{date}"\n---\n\n# {date}\n']
    sources=list(dict.fromkeys(r.get('project_id') for r in recs))
    for source in sources:
        rows=[r for r in recs if r.get('project_id')==source]
        if source is None:out.append(f'## 全局记忆\n{GLOBAL_OPEN}\n')
        else:out.append(f'## {rows[0]["project_name"]}\n<!-- memory:project {compact({"id":source})} -->\n')
        for sid in dict.fromkeys(r['session']['id'] for r in rows):
            session_rows=[r for r in rows if r['session']['id']==sid];session=session_rows[0]['session']
            out.append(f'### 会话 {session["saved_at"][11:16]}\n<!-- memory:session {compact(session)} -->\n')
            for row in session_rows:
                meta={key:row[key] for key in ('id','type','topic','rule_key','status','supersedes','superseded_by','source_record_ids') if key in row}
                out.append(f'<!-- memory:record {compact(meta)} -->\n#### {row["title"]}\n{row["content"]}\n<!-- /memory:record -->\n')
    return '\n'.join(out).rstrip()+'\n'

def parse_profiles(text):
    out=[];lines=text.splitlines();i=0
    while i<len(lines):
        mt=PROFILE_OPEN.fullmatch(lines[i])
        if mt:
            meta=json.loads(mt.group(1));i+=1
            expect(i<len(lines) and lines[i].startswith('## '),'画像标题丢失')
            title=lines[i][3:];i+=1;body=[]
            while i<len(lines) and lines[i]!='<!-- /memory:profile -->':body.append(lines[i]);i+=1
            expect(i<len(lines),'画像缺少结束标记')
            out.append({**meta,'title':title,'content':'\n'.join(body).strip()})
        i+=1
    return out

def render_profiles(domain,profiles):
    out=[f'# {domain}\n']
    for p in profiles:
        meta={k:p[k] for k in ('id','scope','basis','source_record_ids')}
        out.append(f'<!-- memory:profile {compact(meta)} -->\n## {p["title"]}\n{p["content"]}\n<!-- /memory:profile -->\n')
    return '\n'.join(out).rstrip()+'\n'

def all_records(root,overrides=None):
    paths=set(stored_files(root,'daily','.md'))
    if overrides:paths.update(k for k in overrides if k.startswith('daily/') and k.endswith('.md'))
    found=[]
    for rel in sorted(paths):
        b=file_bytes(root,rel,overrides)
        if b is not None:
            for r in parse_daily(b.decode('utf-8')):
                r['file_path']=rel;r['date']=Path(rel).stem;found.append(r)
    ids=[r['id'] for r in found];expect(len(ids)==len(set(ids)),'记忆 ID 在不同日期重复')
    return found

def all_profiles(root,overrides=None):
    result=[]
    for domain in sorted(DOMAINS):
        rel='profile/'+domain+'.md';b=file_bytes(root,rel,overrides)
        if b is not None:
            for p in parse_profiles(b.decode()):p['domain']=domain;result.append(p)
    ids=[p['id'] for p in result];expect(len(ids)==len(set(ids)),'画像 ID 重复')
    return result

def is_active_rule(record: dict) -> bool:
    """旧记录未带状态时保持有效；历史版本不进入当前规则投影。"""
    return record['type'] in RULE_TYPES and record.get('status','active')=='active'

def record_refs(record: dict, key: str) -> list[str]:
    refs=record.get(key,[])
    expect(isinstance(refs,list) and all(isinstance(v,str) for v in refs)
           and len(refs)==len(set(refs)),f'{key} 必须为不重复的 ID 数组')
    return refs

def validate_state(root: Path, overrides: dict | None = None) -> tuple[list[dict],list[dict]]:
    recs=all_records(root,overrides);profiles=all_profiles(root,overrides)
    unique={};refmap={r['id']:r for r in recs};valid_ids=set(refmap)
    for r in recs:
        expect(ID_RE.fullmatch(r['id']) is not None,'非法记忆 ID: '+r['id'])
        expect(r['date']==Path(r['file_path']).stem,'每日文件日期与文件名不一致')
        expect(r['type'] in TYPES,'未知记录类型')
        expect(r.get('status','active') in ('active','superseded'),'非法记录状态')
        sources=record_refs(r,'source_record_ids')
        expect(set(sources).issubset(valid_ids) and r['id'] not in sources,'日记来源不存在或引用自身')
        supersedes=record_refs(r,'supersedes')
        expect(set(supersedes).issubset(valid_ids) and r['id'] not in supersedes,'替代目标不存在或引用自身')
        if r['type'] in RULE_TYPES:
            expect(isinstance(r.get('rule_key'),str) and r['rule_key'].strip(),'规则记录缺少 rule_key')
            if is_active_rule(r):
                # 历史来源的同名规则仍独立，不因全局可检索被合并或自动提升。
                k=(r.get('project_id'),r['rule_key'])
                expect(k not in unique,f'重复有效规则: {k}')
                unique[k]=r['id']
            for rid in supersedes:
                old=refmap[rid]
                expect(old['type'] in RULE_TYPES and old.get('status')=='superseded'
                       and old.get('superseded_by')==r['id'],'替代关系必须指向已被明确替代的规则')
        else:
            expect(not supersedes and r.get('status','active')=='active' and not r.get('superseded_by'),
                   '非规则日记不能参与有效版本替代')
        successor=r.get('superseded_by')
        if successor is not None:
            expect(isinstance(successor,str) and successor in valid_ids,'后继规则不存在')
            newer=refmap[successor]
            expect(r.get('status')=='superseded' and newer['type'] in RULE_TYPES
                   and r['id'] in record_refs(newer,'supersedes'),
                   '后继规则与替代关系不一致')
    for r in recs:
        seen={r['id']};successor=r.get('superseded_by')
        while successor:
            expect(successor not in seen,'规则替代关系存在循环')
            seen.add(successor);successor=refmap[successor].get('superseded_by')
    for p in profiles:
        expect(isinstance(p.get('scope'),str) and (p['scope']=='global'
               or re.fullmatch(r'(domain|project):[a-z0-9-]+',p['scope'])),'画像历史作用域无效')
        expect(ID_RE.fullmatch(p['id']) is not None,'非法画像 ID')
        expect(set(record_refs(p,'source_record_ids')).issubset(valid_ids),'画像引用了已经删除的来源记忆')
    months=set(stored_files(root,'monthly','.md'))
    if overrides:months.update(k for k in overrides if k.startswith('monthly/') and k.endswith('.md'))
    for rel in months:
        b=file_bytes(root,rel,overrides)
        if b is None:continue
        for line in b.decode('utf-8').splitlines():
            mt=SUM_OPEN.fullmatch(line)
            if mt:
                ids=json.loads(mt.group(1))['source_record_ids']
                expect(ids and set(ids).issubset(valid_ids),f'摘要来源已丢失: {rel}')
                expect(all(refmap[rid]['date'][:7]==Path(rel).stem for rid in ids),'摘要跨越指定月份')
    return recs,profiles

def search_paths(root: Path, overrides: dict | None = None) -> list[str]:
    """只枚举全局检索来源；画像保留独立的按领域读取入口。"""
    paths={'manifest.json'}
    # 旧索引可继续核对已有目录表的指纹，但它不再是记忆功能的必需文件。
    if file_bytes(root,'catalog/projects.json',overrides) is not None:paths.add('catalog/projects.json')
    for subtree in ('daily','monthly'):paths.update(stored_files(root,subtree,'.md'))
    for rel,value in (overrides or {}).items():
        if rel in paths or (rel.startswith(('daily/','monthly/')) and rel.endswith('.md')):
            if value is None:paths.discard(rel)
            else:paths.add(rel)
    return sorted(paths)


def source_stamp(path: Path) -> list[int]:
    info=path.stat()
    expect(stat.S_ISREG(info.st_mode),'检索来源不是普通文件: '+str(path))
    return [info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns]


def stable_source(root: Path, rel: str) -> tuple[bytes,list[int]]:
    path=safe(root,rel);before=source_stamp(path);data=path.read_bytes();after=source_stamp(path)
    expect(before==after,'SOURCE_CHANGED：来源读取期间变化，未使用混合版本: '+rel)
    return data,after


def lexical_terms(value: str) -> list[str]:
    """中文双字片段与英文词元；标识符同时保留整体和下划线片段。"""
    tokens=[]
    for run in SEARCH_TOKENS.findall(unicodedata.normalize('NFKC',value).casefold()):
        if run.isascii():parts=[run,*[part for part in run.split('_') if part and part!=run]]
        else:parts=[run] if len(run)==1 else [run[i:i+2] for i in range(len(run)-1)]
        tokens.extend(part for part in parts if part not in SEARCH_STOPWORDS)
    return tokens


def summary_records(data: bytes, rel: str) -> list[dict]:
    """月摘要按文件内序号定位；旧项目标签仅作来源信息。"""
    lines=data.decode('utf-8').splitlines();result=[];project=None;topic='';scope_known=False;i=0
    while i<len(lines):
        line=lines[i];marker=PROJECT_OPEN.fullmatch(line)
        if marker:project=json.loads(marker.group(1))['id'];scope_known=True
        elif line==GLOBAL_OPEN:project=None;scope_known=True
        elif line.startswith('### '):topic=line[4:]
        else:
            marker=SUM_OPEN.fullmatch(line)
            if marker:
                expect(scope_known,'月摘要缺少记忆范围标记: '+rel)
                meta=json.loads(marker.group(1));body=[];i+=1
                while i<len(lines) and lines[i]!='<!-- /memory:summary -->':body.append(lines[i]);i+=1
                expect(i<len(lines),'月摘要缺少结束标记: '+rel)
                result.append({'kind':'summary','key':f'summary:{rel}:{len(result)}','file_path':rel,
                               'month':Path(rel).stem,**({'project_id':project,'project':project} if project is not None else {}),'topic':topic,
                               'content':'\n'.join(body).strip(),'source_record_ids':meta['source_record_ids']})
        i+=1
    return result


def search_document(record: dict, kind: str = 'record') -> dict:
    fields=('id','file_path','date','project_id','type','topic','title','rule_key','status',
            'superseded_by','supersedes','source_record_ids') if kind=='record' else (
                'key','file_path','month','project_id','topic','source_record_ids')
    row={key:record[key] for key in fields if key in record}
    row.update({'kind':kind,'key':'record:'+record['id'] if kind=='record' else record['key']})
    if kind=='record':row['status']=record.get('status','active')
    terms=Counter(lexical_terms(record['content']))
    for field in dict.fromkeys(str(record.get(key) or '') for key in ('title','topic','rule_key')):
        terms.update({term:count*3 for term,count in Counter(lexical_terms(field)).items()})
    row['terms']=dict(terms);row['length']=sum(terms.values())
    return row


def search_fingerprint(index: dict) -> str:
    payload={key:value for key,value in index.items() if key!='fingerprint'}
    return sha(json.dumps(payload,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode())


def build_search_index(snapshot: dict, sources: dict, records: list[dict]) -> dict:
    docs=[search_document(record) for record in records]
    for rel,data in sorted(snapshot.items()):
        if rel.startswith('monthly/'):
            docs.extend(search_document(record,'summary') for record in summary_records(data,rel))
    result={'version':SEARCH_VERSION,'algorithm':SEARCH_ALGORITHM,'sources':sources,'documents':docs}
    result['fingerprint']=search_fingerprint(result)
    return result


def check_search_sources(root: Path, index: dict) -> dict[str,bytes]:
    """文件属性仅作判脏线索；变动来源及返回原文还须核对内容指纹。"""
    sources=index['sources'];verified={}
    expect(search_paths(root)==sorted(sources),'INDEX_STALE：检索来源集合变化，须单独批准重建索引')
    for rel,source in sources.items():
        expect(isinstance(source,dict) and isinstance(source.get('sha256'),str),'INDEX_INVALID：来源版本无效')
        if source.get('stamp')!=source_stamp(safe(root,rel)):
            data,_=stable_source(root,rel)
            expect(sha(data)==source['sha256'],'INDEX_STALE：来源内容已变化: '+rel)
            verified[rel]=data
    return verified


def load_search_index(root: Path) -> tuple[dict,dict[str,bytes]]:
    data=file_bytes(root,SEARCH_INDEX)
    expect(data is not None,'INDEX_MISSING：全局检索索引缺失；须单独批准 reindex，未扫描历史或自动修复')
    index=json.loads(data)
    expect(isinstance(index,dict) and index.get('version')==SEARCH_VERSION
           and index.get('algorithm')==SEARCH_ALGORITHM,'INDEX_VERSION：检索索引版本不适用，须单独批准重建')
    expect(isinstance(index.get('sources'),dict) and isinstance(index.get('documents'),list),
           'INDEX_INVALID：检索索引结构无效')
    expect(index.get('fingerprint')==search_fingerprint(index),'INDEX_INVALID：检索索引指纹不一致')
    keys=set()
    for doc in index['documents']:
        expect(isinstance(doc,dict) and isinstance(doc.get('key'),str) and doc.get('kind') in ('record','summary')
               and isinstance(doc.get('file_path'),str) and doc['file_path'] in index['sources']
               and (doc.get('project_id') is None or isinstance(doc['project_id'],str))
               and isinstance(doc.get('terms'),dict)
               and isinstance(doc.get('length'),int) and doc['length']>=0,'INDEX_INVALID：候选结构无效')
        expect(doc['key'] not in keys,'INDEX_INVALID：候选定位重复');keys.add(doc['key'])
        expect(all(isinstance(term,str) and isinstance(count,int) and count>0
                   for term,count in doc['terms'].items()),'INDEX_INVALID：词项结构无效')
        if doc['kind']=='record':
            expect(isinstance(doc.get('id'),str) and doc['id'].startswith('m_')
                   and ID_RE.fullmatch(doc['id']) is not None and doc['key']=='record:'+doc['id']
                   and doc.get('status') in ('active','superseded') and doc.get('type') in TYPES,
                   'INDEX_INVALID：日记候选身份或状态无效')
    return index,check_search_sources(root,index)


def rank_documents(documents: list[dict], query: str) -> list[tuple[dict,float,list[str]]]:
    """相关性先于时间与项目；不将其他项目的历史决定提升为当前规则。"""
    tokens=set(lexical_terms(query))
    if not tokens:return []
    total=len(documents);average=sum(doc['length'] for doc in documents)/max(total,1) or 1
    frequency=Counter(term for doc in documents for term in tokens if term in doc['terms']);ranked=[]
    for doc in documents:
        hits=sorted(tokens.intersection(doc['terms']))
        if not hits:continue
        score=0.0
        for term in hits:
            count=doc['terms'][term];weight=math.log1p((total-frequency[term]+0.5)/(frequency[term]+0.5))
            score+=weight*count*2.2/(count+1.2*(0.25+0.75*doc['length']/average))
        ranked.append((doc,score*len(hits)/len(tokens),hits))
    ranked.sort(key=lambda item:(-item[1],item[0]['key']))
    return ranked


def hydrate_documents(root: Path, index: dict, documents: list[dict], verified: dict[str,bytes]) -> list[dict]:
    """每个命中文件只解析一次；索引不代替完整原文或真实生命周期。"""
    files={};result=[]
    for doc in documents:
        rel=doc['file_path']
        if rel not in files:
            data=verified.get(rel)
            if data is None:data,_=stable_source(root,rel)
            expect(sha(data)==index['sources'][rel]['sha256'],'INDEX_STALE：原文与索引来源版本不一致: '+rel)
            if rel.startswith('daily/'):
                rows=parse_daily(data.decode('utf-8'))
                for row in rows:row.update({'file_path':rel,'date':Path(rel).stem})
                files[rel]={'record:'+row['id']:row for row in rows}
            else:
                expect(rel.startswith('monthly/'),'INDEX_INVALID：原文定位不属于日记或月摘要')
                files[rel]={row['key']:row for row in summary_records(data,rel)}
        row=files[rel].get(doc['key'])
        expect(row is not None and search_document(row,doc['kind'])==doc,
               'INDEX_STALE：候选身份、状态或检索内容与原文不一致')
        result.append({**row,'kind':doc['kind'],**({'status':row.get('status','active'),
                       'source_record_ids':row.get('source_record_ids',[])} if doc['kind']=='record' else {})})
    check_search_sources(root,index)
    return result


def extract_error_fingerprint(output: str, exit_code: int = 0) -> str:
    """从工具执行输出提取稳定的报错特征串，去除动态内容（路径、PID、时间戳）。"""
    if not output or not isinstance(output, str): return ''
    
    lines = output.splitlines()
    keywords = ['error:', 'failed', 'exception', 'traceback', 'fatal', 'err!', 
                'cannot', 'not found', 'no such', 'permission denied', 'syntax error']
    
    selected = []
    for i, line in enumerate(lines):
        lower = line.lower()
        if any(kw in lower for kw in keywords):
            # 保留当前行及前后各1行上下文
            if i > 0 and lines[i-1].strip():
                selected.append(lines[i-1])
            selected.append(line)
            if i + 1 < len(lines) and lines[i+1].strip():
                selected.append(lines[i+1])
    
    if not selected and exit_code != 0:
        # 无明显错误关键词但退出码非零，保留最后几行
        selected = [l for l in lines[-5:] if l.strip()]
    
    if not selected: return ''
    
    # 去除动态内容
    fingerprint = '\n'.join(selected)
    # 移除绝对路径（Windows 与 Unix）
    fingerprint = re.sub(r'[A-Za-z]:[\\\S]+', '<PATH>', fingerprint)
    fingerprint = re.sub(r'/[\w/\-\.]+', '<PATH>', fingerprint)
    # 移除时间戳
    fingerprint = re.sub(r'\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}', '<TIME>', fingerprint)
    # 移除 PID
    fingerprint = re.sub(r'\bpid[:\s]+\d+', 'pid:<PID>', fingerprint, flags=re.IGNORECASE)
    # 移除临时文件名
    fingerprint = re.sub(r'\btmp[\w\-\.]+', '<TMP>', fingerprint, flags=re.IGNORECASE)
    
    # 限制长度
    if len(fingerprint) > 500:
        fingerprint = fingerprint[:500]
    
    return fingerprint.strip()


def error_recall(root: Path, data: dict) -> dict:
    """报错指纹专用检索：仅匹配 type=issue 的日记记录。"""
    allowed = {'fingerprint', 'limit'}
    expect(isinstance(data, dict) and not set(data) - allowed, '报错召回输入字段无效')
    fingerprint = data.get('fingerprint')
    expect(isinstance(fingerprint, str) and 0 < len(fingerprint.strip()) <= 500, '报错指纹须为有界特征串')
    limit = data.get('limit', 3)
    expect(isinstance(limit, int) and 1 <= limit <= 10, '报错召回数量限制无效')
    
    index, verified = load_search_index(root)
    
    # 只检索 type=issue 的记录
    docs = [doc for doc in index['documents'] 
            if doc['kind'] == 'record' 
            and doc.get('type') == 'issue']
    
    ranked = rank_documents(docs, fingerprint.strip())
    # 相关度门槛：至少匹配到 2 个词项
    eligible = [item for item in ranked if len(item[2]) >= 2]
    
    selected = eligible[:limit]
    rows = hydrate_documents(root, index, [item[0] for item in selected], verified)
    
    fields = ('id', 'type', 'topic', 'title', 'content', 'project_id', 'date', 'file_path', 'status', 'source_record_ids')
    matches = [{**{key: row[key] for key in fields if key in row}, 
                'score': round(item[1], 6), 
                'matched_terms': item[2]} for row, item in zip(rows, selected)]
    
    return {
        'policy': 'error-fingerprint-v1',
        'index_version': index['fingerprint'],
        'fingerprint': fingerprint,
        'memory_scope': 'global',
        'matches': matches,
        'no_match': not matches,
        'note': '报错指纹联动仅匹配 issue 类型日记；不自动沉淀新记录，所有写入仍需人工审批。'
    }


def indexed_recall(root: Path, query: str, mode: str = 'records',
                   month: str | None = None, offset: int = 0, limit: int = 50, allow_empty: bool = False) -> dict:
    """从全局派生索引执行词法召回；content 截断为前 200 字摘要，完整正文需二次调用 read。"""
    expect(mode in ('records','recent','historical','month'),'非法检索模式')
    expect(offset>=0 and 1<=limit<=200,'offset/limit 非法；每批最多 200 条')
    expect(allow_empty or bool(query.strip()),'检索问题不能为空')
    expect((mode=='month' and isinstance(month,str) and re.fullmatch(r'\d{4}-(0[1-9]|1[0-2])',month))
           or (mode!='month' and month is None),'月份必须明确且仅用于 month 模式')
    manifest,zone=load(root);index,verified=load_search_index(root)
    kind='summary' if mode in ('historical','month') else 'record'
    docs=[doc for doc in index['documents'] if doc['kind']==kind]
    if mode=='recent':
        window=manifest['recent_window_days'];expect(1<=window<=366,'recent_window_days 超出合理范围')
        today=dt.datetime.now(zone).date();first=(today-dt.timedelta(days=window-1)).isoformat()
        docs=[doc for doc in docs if first<=doc['date']<=today.isoformat()]
    if mode=='month':docs=[doc for doc in docs if doc['month']==month]
    ranked=rank_documents(docs,query) if query.strip() else [(doc,0.0,[]) for doc in sorted(docs,key=lambda doc:doc['key'])]
    page=ranked[offset:offset+limit];rows=hydrate_documents(root,index,[item[0] for item in page],verified)
    def truncate_content(content: str, limit: int = 200) -> tuple[str, bool]:
        if len(content) <= limit: return content, False
        return content[:limit] + '...', True
    matches=[]
    for row,item in zip(rows,page):
        truncated, was_truncated = truncate_content(row['content'])
        matches.append({**row, 'content': truncated, 'content_truncated': was_truncated,
                        'score':round(item[1],6),'matched_terms':item[2]})
    scope={'records':'all_daily','recent':'recent_daily','historical':'historical_month_summaries','month':'monthly_summary'}[mode]
    missing=mode=='month' and f'monthly/{month[:4]}/{month}.md' not in index['sources']
    return {'status':'MONTHLY_SUMMARY_MISSING' if missing else 'OK','scope':scope,'memory_scope':'global',
            'mode':mode,'month':month,'query':query,'index_version':index['fingerprint'],'coverage':'indexed_sources',
            'matches':matches,'total_matches':len(ranked),'offset':offset,'limit':limit,
            'has_more':offset+limit<len(ranked),'next_offset':offset+limit if offset+limit<len(ranked) else None,
            'no_match':not ranked,'note':'仅词法相关性；历史来源与状态不代表当前适用或事实已核实；摘要需 memory_read 读取全文'}


BACKGROUND_POLICY = 'lexical-global-background-v2'
BACKGROUND_STOPWORDS = {'当前','现在','需要','可以','已经','相关','问题','项目','功能','优化','处理',
                       '继续','一下','看看','进行','是否','推荐','建议','方案','实现','本次','以下',
                       'please','could','would','should','help','with','this','that'}


def background_recall(root: Path, data: dict) -> dict:
    """自动背景专用只读入口；共享词法核心，缓存复用仍核对来源与命中原文。"""
    allowed={'query','recent','date_from','date_to','cache_key','cached_ids'}
    expect(isinstance(data,dict) and not set(data)-allowed,'自动召回输入字段无效')
    query=data.get('query')
    expect(isinstance(query,str) and 0<len(query.strip())<=2000,'自动召回需要有界任务查询')
    manifest,zone=load(root)
    recent=data.get('recent',False)
    expect(type(recent) is bool,'recent 必须为布尔值')
    first,last=data.get('date_from'),data.get('date_to')
    expect(not recent or (first is None and last is None),'近期与明确日期范围不能混用')
    for value in (first,last):
        if value is not None:
            expect(isinstance(value,str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}',value) is not None,
                   '日期范围须为 YYYY-MM-DD')
            dt.date.fromisoformat(value)
    if recent:
        window=manifest['recent_window_days']
        expect(type(window) is int and 1<=window<=366,'近期窗口无效')
        today=dt.datetime.now(zone).date()
        first=(today-dt.timedelta(days=window-1)).isoformat();last=today.isoformat()
    expect(first is None or last is None or first<=last,'日期范围顺序无效')
    cached_ids=data.get('cached_ids',[]);cached_key=data.get('cache_key')
    expect(isinstance(cached_ids,list) and len(cached_ids)<=6
           and all(isinstance(rid,str) and rid.startswith('m_') and ID_RE.fullmatch(rid) for rid in cached_ids)
           and len(set(cached_ids))==len(cached_ids),'自动召回缓存身份无效')
    expect(cached_key is None or (isinstance(cached_key,str) and re.fullmatch(r'[0-9a-f]{64}',cached_key)),
           '自动召回缓存键无效')
    expect(cached_key is not None or not cached_ids,'缓存 ID 缺少所属版本')
    index,verified=load_search_index(root)
    scope={'memory_scope':'global','date_from':first,'date_to':last}
    cache_key=sha(compact([BACKGROUND_POLICY,index['fingerprint'],query,scope]).encode())
    docs=[doc for doc in index['documents'] if doc['kind']=='record' and doc['status']=='active'
          and (first is None or doc['date']>=first) and (last is None or doc['date']<=last)]
    base={'policy':BACKGROUND_POLICY,'index_version':index['fingerprint'],'cache_key':cache_key,
          'scope':scope,'coverage':'indexed_sources'}
    if cached_key==cache_key:
        by_id={doc['id']:doc for doc in docs}
        expect(all(rid in by_id for rid in cached_ids),'缓存记录不属于当前候选范围')
        # 同版本不能跳过原文哈希；空命中也已经检查来源集合与变化文件。
        hydrate_documents(root,index,[by_id[rid] for rid in cached_ids],verified)
        return {**base,'unchanged':True,'ids':cached_ids}
    terms={term for term in lexical_terms(query) if term not in BACKGROUND_STOPWORDS}
    ranked=rank_documents(docs,' '.join(sorted(terms))) if terms else []
    eligible=[item for item in ranked if len(item[2])>=min(2,len(terms))
              and len(item[2])/max(1,len(terms))>=0.12]
    if eligible:
        eligible=[item for item in eligible if item[1]>=eligible[0][1]*0.45]
    # 相关性门槛先于分组，分别保留最多三条规则和三条经历，避免一类挤占全部名额。
    selected=[];counts={'rule':0,'history':0}
    for item in eligible:
        group='rule' if item[0]['type'] in RULE_TYPES else 'history'
        if counts[group]>=3:continue
        counts[group]+=1;selected.append(item)
    rows=hydrate_documents(root,index,[item[0] for item in selected],verified)
    fields=('id','type','topic','title','content','project_id','date','file_path','status','source_record_ids')
    matches=[{**{key:row[key] for key in fields if key in row},'score':round(item[1],6),
              'matched_terms':item[2]} for row,item in zip(rows,selected)]
    return {**base,'unchanged':False,'matches':matches,'ids':[row['id'] for row in matches],
            'no_match':not matches,'eligible_count':len(eligible),
            'note':'自动词法筛选不证明适用性或事实正确；被替代规则不自动注入，完整历史仍可手动查询。'}


def indexed_read(root: Path, ids: list[str]) -> dict:
    expect(1<=len(ids)<=50 and all(isinstance(rid,str) and rid.startswith('m_')
           and ID_RE.fullmatch(rid) is not None for rid in ids),'须指定 1..50 个真实日记 ID')
    index,verified=load_search_index(root)
    by_id={doc['id']:doc for doc in index['documents'] if doc['kind']=='record'}
    expect(all(rid in by_id for rid in ids),'指定记忆 ID 不在当前索引中，未扫描全历史')
    docs=[by_id[rid] for rid in ids]
    return {'records':hydrate_documents(root,index,docs,verified),'memory_scope':'global',
            'index_version':index['fingerprint'],'coverage':'indexed_sources'}


def access_ids(ids: object) -> list[str]:
    """统计只接受真实日记 ID；一次调用中的重复 ID 只计一次。"""
    if not isinstance(ids,list) or not 1<=len(ids)<=50:
        raise MemoryError('访问统计须指定 1..50 个真实日记 ID')
    expect(all(isinstance(rid,str) and rid.startswith('m_') and ID_RE.fullmatch(rid) for rid in ids),
           '访问统计须指定 1..50 个真实日记 ID')
    return list(dict.fromkeys(ids))


def access_time(value: object) -> dt.datetime:
    if not isinstance(value,str):raise MemoryError('ACCESS_INVALID：统计时间无效')
    parsed=dt.datetime.fromisoformat(value)
    expect(parsed.utcoffset() is not None,'ACCESS_INVALID：统计时间缺少时区')
    return parsed


def load_access_state(root: Path) -> dict | None:
    """缺失表示尚未采集；损坏不当作零计数，也不从历史会话重建。"""
    path=safe(root,ACCESS_STORE)
    if not path.exists():return None
    data,_=stable_source(root,ACCESS_STORE)
    state=json.loads(data)
    expect(isinstance(state,dict) and set(state)=={'version','started_at','records'}
           and type(state['version']) is int and state['version']==ACCESS_VERSION
           and isinstance(state['records'],dict),'ACCESS_INVALID：统计结构或版本无效')
    access_time(state['started_at'])
    for rid,row in state['records'].items():
        expect(isinstance(rid,str) and rid.startswith('m_') and ID_RE.fullmatch(rid)
               and isinstance(row,dict) and set(row)=={'read_count','session_count','last_read_at','sessions'}
               and isinstance(row['sessions'],dict) and bool(row['sessions']),
               'ACCESS_INVALID：记录统计结构无效')
        access_time(row['last_read_at'])
        count=0
        for session,events in row['sessions'].items():
            expect(isinstance(session,str) and re.fullmatch('[0-9a-f]{64}',session)
                   and isinstance(events,list) and bool(events)
                   and all(isinstance(event,str) and re.fullmatch('[0-9a-f]{64}',event) for event in events),
                   'ACCESS_INVALID：去重身份无效')
            expect(len(events)==len(set(events)),'ACCESS_INVALID：存在重复调用身份')
            count+=len(events)
        expect(type(row['read_count']) is int and row['read_count']==count
               and type(row['session_count']) is int and row['session_count']==len(row['sessions']),
               'ACCESS_INVALID：计数与去重身份不一致')
    return state


def access_metrics(row: dict | None) -> dict:
    return {'observed':row is not None,'read_count':row['read_count'] if row else 0,
            'session_count':row['session_count'] if row else 0,
            'last_read_at':row['last_read_at'] if row else None}


def access_status(root: Path) -> dict:
    """统计故障只在状态中报告，不使成功的权威记忆读取变成统计故障。"""
    try:
        state=load_access_state(root)
        return {'automatic':True,'status':'available' if state else 'not_collected',
                'file':ACCESS_STORE,'started_at':state['started_at'] if state else None,
                'tracked_records':len(state['records']) if state else 0,'note':ACCESS_NOTE}
    except (MemoryError,ValueError,KeyError,TypeError,UnicodeError,OSError) as error:
        return {'automatic':True,'status':'unavailable','file':ACCESS_STORE,
                'error':str(error)[:1024],'note':ACCESS_NOTE}


def indexed_access_stats(root: Path, ids: list[str]) -> dict:
    ids=access_ids(ids)
    index,_=load_search_index(root)
    available={doc['id']:doc for doc in index['documents'] if doc['kind']=='record'}
    expect(all(rid in available for rid in ids),'指定统计 ID 不在当前索引中，未扫描历史')
    state=load_access_state(root)
    rows=state['records'] if state else {}
    return {'status':'available' if state else 'not_collected','automatic':True,
            'started_at':state['started_at'] if state else None,'index_version':index['fingerprint'],
            'coverage':'recorded_accesses_only','note':ACCESS_NOTE,
            'memory_scope':'global','records':[{'id':rid,'source_project':available[rid].get('project_id'),'date':available[rid]['date'],
                        'status':available[rid]['status'],**access_metrics(rows.get(rid))} for rid in ids]}


def record_access(root: Path, data: dict) -> dict:
    """调用方已准备完整结果；在独占锁内去重并原子写入单份技术统计。"""
    expect(isinstance(data,dict) and set(data)=={'ids','session_id','tool_call_id','index_version'},
           '访问事件字段无效；不接受外部计数、时间或正文')
    ids=access_ids(data['ids'])
    for key in ('session_id','tool_call_id'):
        expect(isinstance(data[key],str) and bool(data[key].strip()) and len(data[key])<=512,
               '访问事件身份无效: '+key)
    expect(isinstance(data['index_version'],str)
           and re.fullmatch('[0-9a-f]{64}',data['index_version']),'访问来源版本无效')
    index,_=load_search_index(root)
    expect(index['fingerprint']==data['index_version'],
           'SOURCE_CHANGED：读取后来源版本已变化，未计入访问统计')
    available={doc['id'] for doc in index['documents'] if doc['kind']=='record'}
    expect(set(ids).issubset(available),'访问记录已不在当前索引中，未写统计')
    now=dt.datetime.now(dt.timezone.utc).isoformat(timespec='milliseconds')
    state=load_access_state(root)
    if state is None:state={'version':ACCESS_VERSION,'started_at':now,'records':{}}
    session=sha(('pi-memory.access.session\0'+data['session_id']).encode())
    event=sha(('pi-memory.access.call\0'+data['session_id']+'\0'+data['tool_call_id']).encode())
    added=0
    for rid in ids:
        row=state['records'].get(rid)
        if row is None:
            row={'read_count':0,'session_count':0,'last_read_at':now,'sessions':{}}
            state['records'][rid]=row
        events=row['sessions'].get(session)
        if events is not None and event in events:continue
        if events is None:
            events=[];row['sessions'][session]=events;row['session_count']+=1
        events.append(event);row['read_count']+=1
        row['last_read_at']=max(row['last_read_at'],now,key=access_time)
        added+=1
    if added:atomic_write(safe(root,ACCESS_STORE),j(state).encode())
    return {'status':'recorded' if added else 'duplicate','new_records':added,
            'duplicate_records':len(ids)-added}


def search_semantics(index: dict) -> dict:
    """来源属性是缓存提示，不能把事务落盘后的属性变化误判为语义索引变化。"""
    return {**{key:value for key,value in index.items() if key not in ('fingerprint','sources')},
            'sources':{rel:{'sha256':value['sha256']} for rel,value in index['sources'].items()}}


def index_updates(root: Path, overrides: dict[str,bytes | None]) -> dict[str,bytes]:
    snapshot={};sources={}
    for rel in search_paths(root,overrides):
        if rel in overrides:data=overrides[rel];stamp=None
        else:data,stamp=stable_source(root,rel)
        snapshot[rel]=data
        # 改写来源尚未落盘，不猜最终文件属性；读取时仅对这些来源核对内容指纹。
        sources[rel]={'sha256':sha(data),'stamp':stamp}
    recs,profiles=validate_state(root,{**overrides,**snapshot})
    # 可选元数据按实际字段投影，未修改的旧日记不因升级被要求重建索引。
    entries={r['id']:{k:r.get(k) for k in ('file_path','date','project_id','type','topic','rule_key')}
             |{'session_id':r['session']['id']}
             |{k:r[k] for k in ('status','superseded_by','supersedes','source_record_ids') if k in r} for r in recs}
    rules={compact([r.get('project_id'),r['rule_key']]):r['id'] for r in recs if is_active_rule(r)}
    months={}
    for r in recs:
        m=r['date'][:7];months.setdefault(m,{'record_count':0,'summary_available':False})
        months[m]['record_count']+=1
    summary_paths=set(stored_files(root,'monthly','.md'))
    summary_paths.update(k for k in overrides if k.startswith('monthly/') and k.endswith('.md'))
    for rel in summary_paths:
        if file_bytes(root,rel,overrides) is None:continue
        m=Path(rel).stem;months.setdefault(m,{'record_count':0,'summary_available':False})['summary_available']=True
    return {'index/records.json':j(entries).encode(),'index/rules.json':j(rules).encode(),
            'index/months.json':j(months).encode(),SEARCH_INDEX:j(build_search_index(snapshot,sources,recs)).encode()}

def invalidate_months(root,changes,months):
    for month in months:
        rel=f'monthly/{month[:4]}/{month}.md'
        if file_bytes(root,rel,changes) is not None:changes[rel]=None

def plan_saved(root: Path, operation: str, payload: dict) -> dict:
    # 只清理过期技术候选，不借生成新计划删除权威记忆。
    plans=safe(root,'.system/plans')
    if plans.exists():
        for p in plans.glob('s_*.json'):
            if p.is_symlink(): continue
            try:
                if time.time()-parse_json(p).get('created_at',0)>24*3600:p.unlink()
            except (ValueError,KeyError,OSError): pass
    out={'plan_version':PLAN_VERSION,'memory_scope':'global','plan_id':ulid('s'),'operation':operation,'created_at':time.time(),'expected_fingerprint':root_fingerprint(root),'payload':payload}
    rel='.system/plans/'+out['plan_id']+'.json'
    atomic_write(safe(root,rel),j(out).encode())
    return out

def render_preview(plan: dict) -> dict:
    op=plan['operation'];d=plan['payload']
    result={'plan_version':plan['plan_version'],'memory_scope':'global','plan_id':plan['plan_id'],'operation':op,'expires_in_hours':24}
    if op=='save':
        result.update({'memory_scope':'global','date':d['date'],'new_records':d['records'],
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
    if op in ('save','delete'):
        result['withdrawn_months']=d['withdrawn_months']
    return result

def month_closed(month, zone, closed_today_confirmed=False):
    expect(re.fullmatch(r'\d{4}-(0[1-9]|1[0-2])',month),'非法月份')
    now=dt.datetime.now(zone)
    current=now.strftime('%Y-%m')
    last=(now+dt.timedelta(days=1)).month!=now.month
    expect(month<current or (month==current and last and closed_today_confirmed is True),
           '目标月份尚未结束，拒绝生成正式摘要')


def monthly_source(root: Path, month: str, offset: int = 0, limit: int = 50, closed_today_confirmed: bool = False) -> dict:
    _,zone=load(root)
    month_closed(month,zone,closed_today_confirmed)
    expect(offset>=0 and 1<=limit<=200,'offset/limit 非法；每批最多 200 条')
    selected=[r for r in all_records(root) if r['date'].startswith(month+'-')]
    selected.sort(key=lambda r:(r['date'],r['session']['saved_at'],r['id']))
    page=selected[offset:offset+limit]
    return {'memory_scope':'global','month':month,'total_records':len(selected),'offset':offset,'limit':limit,
            'has_more':offset+limit<len(selected),
            'next_offset':offset+len(page) if offset+limit<len(selected) else None,
            'records':[{'id':r['id'],'source_project':r.get('project_id'),'source_project_name':r.get('project_name'),
                        'date':r['date'],'session_id':r['session']['id'], 'type':r['type'],
                        'topic':r['topic'],'rule_key':r.get('rule_key'),'content':r['content'],
                        'status':r.get('status','active'),'superseded_by':r.get('superseded_by'),
                        'source_record_ids':r.get('source_record_ids',[])} for r in page]}


def active_rules(root: Path, query: str = '', offset: int = 0, limit: int = 50) -> dict:
    """查询全局库有效规则；历史来源保持原命名空间，不因同键而合并。"""
    index,verified=load_search_index(root)
    expect(offset>=0 and 1<=limit<=200,'offset/limit 非法；每批最多 200 条')
    selected=[doc for doc in index['documents'] if doc['kind']=='record' and is_active_rule(doc)]
    if query.strip():selected=[item[0] for item in rank_documents(selected,query)]
    else:selected.sort(key=lambda doc:(doc.get('project_id') or '',doc.get('rule_key',''),doc['date'],doc['id']))
    page=hydrate_documents(root,index,selected[offset:offset+limit],verified)
    def truncate_content(content: str, limit: int = 200) -> tuple[str, bool]:
        if len(content) <= limit: return content, False
        return content[:limit] + '...', True
    rules=[]
    for r in page:
        truncated, was_truncated = truncate_content(r['content'])
        rules.append({'id':r['id'],'date':r['date'],'source_project':r.get('project_id'),'file_path':r['file_path'],
                      'status':'active','rule_key':r.get('rule_key'),
                      'type':r['type'],'topic':r['topic'],'content':truncated,'content_truncated':was_truncated,
                      'source_record_ids':r.get('source_record_ids',[]),
                      'supersedes':r.get('supersedes',[])})
    return {'memory_scope':'global','total_rules':len(selected),'offset':offset,'limit':limit,
            'index_version':index['fingerprint'],'coverage':'indexed_sources',
            'has_more':offset+limit<len(selected),
            'next_offset':offset+len(page) if offset+limit<len(selected) else None,
            'rules':rules,'note':'返回摘要，完整正文需调用 memory_read'}


def prepare(root: Path, op: str, data: dict) -> dict:
    _,z=load(root)
    allowed={'save':{'agent','session_id','records'},
             'delete':{'ids'},
             'profile':{'domain','scope','basis','title','content','source_record_ids','replace_profile_ids'},
             'month':{'month','topics','closed_today_confirmed','rebuild_existing'}}
    expect(op in allowed and isinstance(data,dict) and not set(data)-allowed[op],
           '全局记忆候选包含不支持字段；不接受项目绑定或登记参数')
    records,_=validate_state(root);existing_ids={r['id']:r for r in records}
    if op=='save':
        now=dt.datetime.now(z);date=now.date().isoformat();saved_at=now.isoformat(timespec='seconds')
        session_id=data.get('session_id') or ulid('s')
        expect(isinstance(session_id,str) and ID_RE.fullmatch(session_id) is not None,'非法 session_id')
        preexisting=[r for r in records if r['session']['id']==session_id]
        expect(not preexisting,'此会话已保存，须先判断差异，不能通过更换 ID 重复保存')
        out=[];supersede=[];seen_keys=set();superseded_ids=set()
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
                    if r.get('project_id') is None and r.get('rule_key')==rule_key and is_active_rule(r):
                        targets.append((r,'相同 rule_key 的新决定取代旧决定，旧正文保留'))
                for rid in explicit_ids:
                    expect(rid in existing_ids,'显式替代目标 ID 不存在: '+rid)
                    previous=existing_ids[rid]
                    expect(is_active_rule(previous),'显式替代只能指向当前有效规则: '+rid)
                    expect(all(r['id']!=rid for r,_ in targets),'同键目标已自动列入，不要重复显式指定')
                    targets.append((previous,candidate_check(item.get('supersession_reason',''))))
            else:
                expect(not rule_key and not explicit_ids,'非规则日记不能带规则键或替代目标')
            rid=ulid('m');title=candidate_check(item['topic'],True);content=candidate_check(item['content'])
            new_record={'id':rid,'type':typ,'topic':title,'title':title,'content':content}
            if typ in RULE_TYPES:new_record.update({'rule_key':rule_key,'status':'active'})
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
        expect(out,'没有可保存的候选记录')
        withdrawn=[date[:7]] if file_bytes(root,f'monthly/{date[:4]}/{date[:7]}.md') is not None else []
        payload={'date':date,'saved_at':saved_at,'session_id':session_id,'agent':candidate_check(data.get('agent','unknown'),True),
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
                                 'removed_source_record_ids':removed_sources,'removed_supersedes':removed_supersedes,
                                 'removed_superseded_by':removed_successor})
        affected_profiles=[p for p in all_profiles(root) if doomed.intersection(p.get('source_record_ids',[]))]
        months={existing_ids[rid]['date'][:7] for rid in ids}
        withdrawn=[m for m in sorted(months) if file_bytes(root,f'monthly/{m[:4]}/{m}.md') is not None]
        access=load_access_state(root)
        access_rows=access['records'] if access else {}
        payload={'records':[{k:existing_ids[rid].get(k) for k in ('id','date','project_id','type','topic','content')} for rid in ids],
                 'affected_record_references':affected,'affected_profiles':affected_profiles,'withdrawn_months':withdrawn,
                 'access_statistics':{'file':ACCESS_STORE,'target_ids':ids,
                     'observed':[{'id':rid,**access_metrics(access_rows.get(rid))} for rid in ids],
                     'note':'删除目标在提交时的全部对应统计；审批期间新增的目标访问同属此范围，不删除其他记录统计。'}}
    elif op=='profile':
        domain=data['domain'];expect(domain in DOMAINS,'非法画像领域')
        scope=data['scope'];expect(scope in ('global','domain:'+domain),'新增画像仅接受 global 或所选领域作用域')
        basis=data['basis'];expect(basis in ('explicit','inferred_confirmed'),'非法画像依据')
        sources=record_refs(data,'source_record_ids');expect(set(sources).issubset(existing_ids),'未知画像来源')
        replace_ids=record_refs(data,'replace_profile_ids');available=all_profiles(root)
        expect(all(any(p['id']==v and p['domain']==domain for p in available) for v in replace_ids),'画像替换目标不存在或不同领域')
        payload={'domain':domain,'profile':{'id':ulid('p'),'scope':scope,'basis':basis,'source_record_ids':sources,
                 'title':candidate_check(data['title'],True),'content':candidate_check(data['content'])},
                 'replace_ids':replace_ids,'replaced_profiles':[p for p in available if p['id'] in replace_ids]}
    elif op=='month':
        month=data['month'];month_closed(month,z,data.get('closed_today_confirmed',False))
        now=dt.datetime.now(z);rel=f'monthly/{month[:4]}/{month}.md'
        expect(not safe(root,rel).exists() or data.get('rebuild_existing') is True,'已有正式摘要；明确指定重建才可覆盖')
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
    else:raise MemoryError('不支持的计划操作')
    return plan_saved(root,op,payload)

def commit(root: Path, plan_id: str) -> dict:
    expect(isinstance(plan_id,str) and plan_id.startswith('s_') and ID_RE.fullmatch(plan_id) is not None,'非法计划 ID')
    p=safe(root,'.system/plans/'+plan_id+'.json');expect(p.exists(),'计划不存在/已提交')
    plan=parse_json(p)
    expect(plan.get('plan_version')==PLAN_VERSION and plan.get('memory_scope')=='global',
           'PLAN_VERSION：旧语义计划不能提交，必须重新生成并确认')
    expect(time.time()-plan['created_at']<=24*3600,'计划已过期')
    expect(plan['expected_fingerprint']==root_fingerprint(root),'STALE_PLAN：记忆库内容已经变化，必须重新预览')
    op=plan['operation'];data=plan['payload'];changes={};existing=all_records(root)
    if op=='month':
        _,z=load(root);month_closed(data['month'],z,data.get('closed_today_confirmed',False))
    withdrawn_months=[];deleted_access_statistics=[]
    if op=='save':
        successors={r['id']:r['superseded_by'] for r in data['supersede']}
        daypath=f'daily/{data["date"][:4]}/{data["date"][5:7]}/{data["date"]}.md'
        paths={r['file_path'] for r in existing if r['id'] in successors}|{daypath}
        for rel in paths:
            entries=[]
            for r in existing:
                if r['file_path']!=rel:continue
                entry=dict(r)
                if r['id'] in successors:
                    entry.update({'status':'superseded','superseded_by':successors[r['id']]})
                entries.append(entry)
            if rel==daypath:
                entries.extend({**r,'session':{'id':data['session_id'],'saved_at':data['saved_at'],'agent':data['agent']}}
                               for r in data['records'])
            changes[rel]=render_daily(Path(rel).stem,entries).encode()
        # 替代只调整有效性；旧月份的原文、来源 ID 和历史摘要仍然成立。
        withdrawn_months=data['withdrawn_months']
        invalidate_months(root,changes,withdrawn_months)
    elif op=='delete':
        deleted={r['id'] for r in data['records']}
        access_plan=data.get('access_statistics')
        expect(isinstance(access_plan,dict) and access_plan.get('file')==ACCESS_STORE
               and isinstance(access_plan.get('target_ids'),list)
               and all(isinstance(rid,str) for rid in access_plan['target_ids'])
               and len(access_plan['target_ids'])==len(deleted) and set(access_plan['target_ids'])==deleted,
               'PLAN_VERSION：删除计划未完整展示访问统计范围，须重新生成并确认')
        access=load_access_state(root)
        if access is not None:
            deleted_access_statistics=sorted(deleted.intersection(access['records']))
            if deleted_access_statistics:
                for rid in deleted_access_statistics:del access['records'][rid]
                changes[ACCESS_STORE]=j(access).encode()
        affected={r['id'] for r in data['affected_record_references']}
        paths={r['file_path'] for r in existing if r['id'] in deleted or r['id'] in affected}
        for rel in paths:
            entries=[]
            for r in existing:
                if r['file_path']!=rel or r['id'] in deleted:continue
                entry=dict(r)
                for key in ('source_record_ids','supersedes'):
                    if key in entry:entry[key]=[rid for rid in entry[key] if rid not in deleted]
                if entry.get('superseded_by') in deleted:entry.pop('superseded_by')
                # 删除后继不能让已经过时的旧决定重新成为当前规则。
                entries.append(entry)
            changes[rel]=render_daily(Path(rel).stem,entries).encode() if entries else None
        for domain in DOMAINS:
            rel='profile/'+domain+'.md';b=file_bytes(root,rel)
            if b is None:continue
            profiles=parse_profiles(b.decode());changed=False
            for profile in profiles:
                sources=profile.get('source_record_ids',[]);cleaned=[rid for rid in sources if rid not in deleted]
                if cleaned!=sources:profile['source_record_ids']=cleaned;changed=True
            if changed:changes[rel]=render_profiles(domain,profiles).encode()
        withdrawn_months=data['withdrawn_months']
        invalidate_months(root,changes,withdrawn_months)
    elif op=='profile':
        rel='profile/'+data['domain']+'.md';old=file_bytes(root,rel)
        profiles=parse_profiles(old.decode()) if old else []
        profiles=[p for p in profiles if p['id'] not in data['replace_ids']]
        profiles.append(data['profile'])
        changes[rel]=render_profiles(data['domain'],profiles).encode()
    elif op=='month':
        m=data['month'];rel=f'monthly/{m[:4]}/{m}.md'
        output=[f'---\nschema_version: "{SCHEMA}"\nmonth: "{m}"\ngenerated_at: "{data["generated_at"]}"\n---\n\n# {m} 工作回顾\n']
        output.append(f'## 全局回顾\n{GLOBAL_OPEN}\n')
        for topic in data['topics']:
            output.append(f'### {topic["title"]}\n<!-- memory:summary {compact({"source_record_ids":topic["source_record_ids"]})} -->\n{topic["content"]}\n<!-- /memory:summary -->\n')
        changes[rel]='\n'.join(output).encode()
    else:raise MemoryError('不支持的全局记忆计划操作')
    changes.update(index_updates(root,changes))
    apply_transaction(root,changes);p.unlink()
    return {'memory_scope':'global','committed':plan_id,'operation':op,'changed_files':sorted(changes),
            'withdrawn_months':withdrawn_months,'deleted_access_statistics_ids':deleted_access_statistics,
            'superseded_record_ids':[r['id'] for r in data['supersede']] if op=='save' else []}

def cmd_search(root: Path, args: argparse.Namespace) -> dict:
    """既有入口保留近期语义；全局召回使用 recall，二者共用索引与排序。"""
    expect(not (args.historical and (args.month or args.all_dates)),'--historical 不能与 --month/--all-dates 合用')
    expect(not (args.month and args.all_dates),'--month 不能与 --all-dates 合用')
    mode='historical' if args.historical else 'month' if args.month else 'records' if args.all_dates else 'recent'
    return indexed_recall(root,args.query,mode,args.month,0,args.limit,allow_empty=True)

def main() -> None:
    parser=argparse.ArgumentParser(description=__doc__)
    # 桌面受管环境用 -I 隔离运行，不能靠环境变量传时区路径；这里显式接收随包 IANA 目录。
    parser.add_argument('--tzdata',default=None,help='explicit IANA directory shipped with the app; default keeps system/tzdata behavior')
    parser.add_argument('--store',default=str(Path.home()/'.agents'/'memory-store'),help='memory-store directory (default: ~/.agents/memory-store; override only for tests/migration)')
    sub=parser.add_subparsers(dest='cmd',required=True)
    init=sub.add_parser('init');init.add_argument('--timezone',required=True)
    sub.add_parser('status');sub.add_parser('validate');sub.add_parser('reindex');sub.add_parser('months')
    rc=sub.add_parser('recover');rc.add_argument('--approved',action='store_true')
    pp=sub.add_parser('plan');pp.add_argument('operation',choices=['save','delete','profile','month']);pp.add_argument('--input',required=True)
    cm=sub.add_parser('commit');cm.add_argument('--plan-id',required=True);cm.add_argument('--approved',action='store_true')
    sr=sub.add_parser('search');sr.add_argument('--query',default='');sr.add_argument('--month');sr.add_argument('--all-dates',action='store_true');sr.add_argument('--historical',action='store_true');sr.add_argument('--limit',type=int,default=50)
    recall=sub.add_parser('recall');recall.add_argument('--query',required=True);recall.add_argument('--mode',choices=['records','recent','historical','month'],default='records');recall.add_argument('--month');recall.add_argument('--offset',type=int,default=0);recall.add_argument('--limit',type=int,default=50)
    background=sub.add_parser('recall-background');background.add_argument('--input',required=True,choices=['-'])
    error=sub.add_parser('error-recall');error.add_argument('--input',required=True,choices=['-'])
    rules=sub.add_parser('rules');rules.add_argument('--query',default='');rules.add_argument('--offset',type=int,default=0);rules.add_argument('--limit',type=int,default=50)
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
        expect(not root.exists() or not any(root.iterdir()),'目标目录非空，禁止覆盖')
        try:ZoneInfo(args.timezone)
        except ZoneInfoNotFoundError:raise MemoryError('IANA 时区不可用；Windows 可安装 tzdata')
        root.mkdir(parents=True,exist_ok=True)
        for d in ['daily','monthly','profile','index','.system/plans','.system/transactions']:(root/d).mkdir(parents=True,exist_ok=True)
        atomic_write(root/'manifest.json',j({'schema_version':SCHEMA,'timezone':args.timezone,'recent_window_days':30}).encode())
        for d in DOMAINS:atomic_write(root/'profile'/f'{d}.md',f'# {d}\n'.encode())
        atomic_write(root/'.system'/'lock',b'0')
        with locking(root,True): apply_transaction(root,index_updates(root,{}))
        result={'initialized':str(root),'schema_version':SCHEMA}
    else:
        load(root)
        if args.cmd=='recover':
            expect(args.approved,'恢复事务必须先取得明确授权，再使用 --approved')
            with locking(root,True,allow_recovery=True):recover(root)
            result={'recovered':True}
        elif args.cmd=='status':
            with locking(root):
                man,_=load(root)
                result={'memory_scope':'global','root':str(root),'manifest':man,'records':len(all_records(root)),
                        'profiles':len(all_profiles(root)),'access_statistics':access_status(root)}
        elif args.cmd=='validate':
            with locking(root):
                rs,ps=validate_state(root)
                expected=index_updates(root,{})
                for name,contents in expected.items():
                    if name==SEARCH_INDEX:
                        current,_=load_search_index(root)
                        expect(search_semantics(current)==search_semantics(json.loads(contents)),
                               'INDEX_STALE：检索索引语义不一致，须单独批准 reindex')
                    else:expect(file_bytes(root,name)==contents,'INDEX_STALE：索引不一致，须单独批准 reindex: '+name)
                result={'valid':True,'records':len(rs),'profiles':len(ps)}
        elif args.cmd=='months':
            with locking(root):
                expected=index_updates(root,{})
                result={'months':json.loads(expected['index/months.json'])}
        elif args.cmd=='reindex':
            with locking(root,True):
                changes=index_updates(root,{})
                apply_transaction(root,changes)
                result={'rebuilt':sorted(changes)}
        elif args.cmd=='plan':
            raw_input=json.loads(sys.stdin.buffer.read().decode('utf-8')) if args.input=='-' else parse_json(Path(args.input))
            with locking(root,True):result=render_preview(prepare(root,args.operation,raw_input))
        elif args.cmd=='commit':
            expect(args.approved,'必须明确 --approved；Skill 必须先展示变更并取得用户确认')
            with locking(root,True):result=commit(root,args.plan_id)
        elif args.cmd=='recall':
            with locking(root):result=indexed_recall(root,args.query,args.mode,args.month,args.offset,args.limit)
        elif args.cmd=='recall-background':
            raw=sys.stdin.buffer.read(65_537)
            expect(len(raw)<=65_536,'自动召回输入超过上限')
            raw_input=json.loads(raw.decode('utf-8'))
            with locking(root):result=background_recall(root,raw_input)
        elif args.cmd=='error-recall':
            raw=sys.stdin.buffer.read(65_537)
            expect(len(raw)<=65_536,'报错召回输入超过上限')
            raw_input=json.loads(raw.decode('utf-8'))
            with locking(root):result=error_recall(root,raw_input)
        elif args.cmd=='search':
            with locking(root):result=cmd_search(root,args)
        elif args.cmd=='rules':
            with locking(root):result=active_rules(root,args.query,args.offset,args.limit)
        elif args.cmd=='month-source':
            with locking(root):result=monthly_source(root,args.month,args.offset,args.limit,args.closed_today_confirmed)
        elif args.cmd=='read':
            with locking(root):result=indexed_read(root,args.ids)
        elif args.cmd=='access-record':
            raw_input=json.loads(sys.stdin.buffer.read().decode('utf-8'))
            expect(safe(root,'.system/lock').is_file(),'已有锁文件缺失；访问统计不会补建锁文件')
            with locking(root,True,blocking=False,existing_only=True):result=record_access(root,raw_input)
        elif args.cmd=='access-stats':
            with locking(root):result=indexed_access_stats(root,args.ids)
        elif args.cmd=='profiles':
            with locking(root):result={'memory_scope':'global','profiles':[x for x in all_profiles(root) if not args.domain or x['domain']==args.domain]}
        else:raise MemoryError('未知操作')
    print(j({'ok':True,'data':result,'error':None}),end='')

if __name__=='__main__':
    if hasattr(sys.stdin,'reconfigure'):sys.stdin.reconfigure(encoding='utf-8')
    if hasattr(sys.stdout,'reconfigure'):sys.stdout.reconfigure(encoding='utf-8')
    try:main()
    except (MemoryError,ValueError,KeyError,TypeError,UnicodeError,json.JSONDecodeError,OSError) as e:
        print(j({'ok':False,'data':None,'error':{'type':e.__class__.__name__,'message':str(e)}}),end='')
        sys.exit(1)
