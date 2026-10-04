#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Builds the public GitHub job list ("Remote jobs open to applicants in India") from ROLIVA's public JSON export.
// Plain Node 22, no dependencies, no secrets: it reads one public URL and writes two files.
//
//   node github-job-list.mjs --out <dir>                                   # remote-india from https://rolivajobs.com
//   node github-job-list.mjs --out <dir> --list freshers-india
//   node github-job-list.mjs --out <dir> --base-url https://rolivajobs.com
//   node github-job-list.mjs --out <dir> --input export.json             # local file instead of fetching
//   node github-job-list.mjs --out <dir> --pause-if-stale 72             # no fetch: pause a list not updated for 72h
//
// Writes <dir>/README.md (intro, how the list is made, disclaimer, one Markdown table per role) and <dir>/data.json
// (exactly the rows shown). Fails closed: a fetch error, a response that does not match the schema, or a list that
// shrank below --min-ratio (default 0.5) of the previous data.json exits non-zero and leaves both files untouched.
// Exit codes: 0 written (or nothing to pause), 1 usage, 2 fetch/validation failure, 3 shrink guard, 4 paused.
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

export const DEFAULT_BASE_URL='https://rolivajobs.com';
export const MAX_RESPONSE_BYTES=2_000_000,MAX_ROWS=1000,FETCH_TIMEOUT_MS=30_000;
export const INCLUDED_ATS=Object.freeze(['greenhouse','lever','ashby']);
export const ELIGIBILITY_LABELS=Object.freeze({india:'India','india-region':'Region of India',apac:'APAC',worldwide:'Worldwide','india-location':'Based in India'});
export const LISTS=Object.freeze({
 'remote-india':Object.freeze({heading:'Remote jobs open to applicants in India',campaign:'remote-india',
  intro:'A daily-updated list of **remote roles whose own listing says they are open to candidates in India**, in an Indian region, across APAC, or worldwide.',
  selection:['A remote role appears only when its listing names India, a region of India, APAC / Asia-Pacific / Asia, or says worldwide or anywhere. A bare "Remote", a time zone, or an office country on its own never counts.']}),
 'freshers-india':Object.freeze({heading:'Entry-level, graduate and internship jobs in India',campaign:'freshers-india',
  intro:'A daily-updated list of **entry-level, graduate, junior, internship, trainee and apprentice roles** located in India, or remote and open to candidates in India.',
  selection:['A role appears only when its title, the employer’s stated level or its employment type marks it as entry-level, graduate, junior, internship, trainee or apprentice. Titles that also say senior, lead, manager, principal, director or head are left out.',
   'It must also be located in India (the employer’s stated country), or be remote with India, a region of India, APAC or worldwide named as an allowed location.']})
});

const usage='usage: github-job-list.mjs --out <dir> [--list remote-india|freshers-india] [--base-url URL] [--input file.json] [--min-ratio 0.5] [--pause-if-stale HOURS] [--allow-http]';
export function parseArgs(argv){
 const opts={list:'remote-india',baseUrl:DEFAULT_BASE_URL,minRatio:0.5,allowHttp:false};
 for(let i=0;i<argv.length;i++){
  const flag=argv[i],next=()=>{const v=argv[++i];if(v===undefined)throw new Error(`MISSING_VALUE ${flag}`);return v;};
  if(flag==='--out')opts.out=next();else if(flag==='--list')opts.list=next();else if(flag==='--base-url')opts.baseUrl=next();
  else if(flag==='--input')opts.input=next();else if(flag==='--min-ratio')opts.minRatio=Number(next());
  else if(flag==='--pause-if-stale')opts.pauseHours=Number(next());else if(flag==='--allow-http')opts.allowHttp=true;
  else throw new Error(`UNKNOWN_FLAG ${flag}`);
 }
 if(!opts.out)throw new Error('MISSING_OUT');
 if(!LISTS[opts.list])throw new Error('UNKNOWN_LIST');
 if(!(opts.minRatio>=0&&opts.minRatio<=1))throw new Error('INVALID_MIN_RATIO');
 if(opts.pauseHours!==undefined&&!(opts.pauseHours>0))throw new Error('INVALID_PAUSE_HOURS');
 const base=new URL(opts.baseUrl);if(base.protocol!=='https:'&&!(opts.allowHttp&&base.protocol==='http:'))throw new Error('BASE_URL_NOT_HTTPS');
 opts.baseUrl=base.origin;
 return opts;
}
export const exportUrl=(baseUrl,list)=>`${baseUrl}/api/public/lists/${list}.json`;

// --- Validation (fail closed: one bad field rejects the whole response) -------------------------------------------
const str=(v,max,min=1)=>typeof v==='string'&&v.length>=min&&v.length<=max&&!/\p{Cc}/u.test(v);
const isoTime=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v)&&Number.isFinite(Date.parse(v));
const url=(v,protocols)=>{try{const u=new URL(v);return str(v,2048)&&protocols.includes(u.protocol)?u:null;}catch{return null;}};
/** Returns the validated payload or throws INVALID_EXPORT:<reason>. */
export function validatePayload(payload,{list,baseUrl,allowHttp=false}){
 const fail=reason=>{throw new Error(`INVALID_EXPORT:${reason}`);};
 if(!payload||typeof payload!=='object'||Array.isArray(payload))fail('not_object');
 if(payload.schema_version!==1)fail('schema_version');
 if(payload.list!==list)fail('list');
 if(!isoTime(payload.generated_at))fail('generated_at');
 if(!Array.isArray(payload.jobs)||payload.jobs.length>MAX_ROWS)fail('jobs');
 const own=allowHttp?['https:','http:']:['https:'],origin=new URL(baseUrl).origin,ids=new Set();
 payload.jobs.forEach((job,i)=>{
  const bad=field=>fail(`jobs[${i}].${field}`);
  if(!job||typeof job!=='object')bad('row');
  if(!str(job.id,80)||ids.has(job.id))bad('id');ids.add(job.id);
  if(!str(job.title,200))bad('title');if(!str(job.company,200))bad('company');if(!str(job.location,160,0))bad('location');
  if(!ELIGIBILITY_LABELS[job.eligibility])bad('eligibility');
  if(job.posted_date!==null&&!(typeof job.posted_date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(job.posted_date)))bad('posted_date');
  const roliva=url(job.roliva_url,own);if(!roliva||roliva.origin!==origin||!roliva.pathname.startsWith('/jobs/'))bad('roliva_url');
  if(!url(job.apply_url,['https:']))bad('apply_url');
  // Defence in depth: the export already allows only these sources; the list refuses anything else as well.
  if(typeof job.source_ats!=='string'||!job.source_ats.split('+').every(a=>INCLUDED_ATS.includes(a)))bad('source_ats');
  if(!isoTime(job.first_seen_at))bad('first_seen_at');if(!isoTime(job.last_checked_at))bad('last_checked_at');
  if(job.role!==null&&!(job.role&&str(job.role.slug,80)&&/^[a-z0-9-]+$/.test(job.role.slug)&&str(job.role.label,80)))bad('role');
 });
 return payload;
}

// --- Markdown -----------------------------------------------------------------------------------------------------
/** Escape text for a Markdown table cell: no HTML, no links, no emphasis, no pipes, one line. */
export const cell=text=>String(text??'').replace(/\s+/g,' ').trim().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
 .replace(/([\\`*_[\]|~])/g,'\\$1');
/** A link target that cannot break out of Markdown link syntax. */
export const href=value=>new URL(value).href.replace(/[()<> ]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const withUtm=(value,campaign)=>{const u=new URL(value);u.searchParams.set('utm_source','github');u.searchParams.set('utm_medium','list');u.searchParams.set('utm_campaign',campaign);return u.href;};
const utc=iso=>`${iso.slice(0,10)} ${iso.slice(11,16)} UTC`;
const OTHER='Other roles';
/** Rows grouped by role label, biggest group first, "Other roles" last; newest posting first inside a group. */
export function groupByRole(jobs){
 const groups=new Map();
 for(const job of jobs){const key=job.role?.label||OTHER;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(job);}
 const when=j=>Date.parse(j.posted_date||j.first_seen_at);
 for(const rows of groups.values())rows.sort((a,b)=>when(b)-when(a)||a.company.localeCompare(b.company)||a.title.localeCompare(b.title)||a.id.localeCompare(b.id));
 return [...groups.entries()].sort(([a,ra],[b,rb])=>(a===OTHER)-(b===OTHER)||rb.length-ra.length||a.localeCompare(b));
}
function tableHtml(rows,campaign){
 const lines=['| Company | Role | Location | Eligibility | Posted | Link |','|---|---|---|---|---|---|'];
 for(const j of rows)lines.push(`| ${cell(j.company)} | ${cell(j.title)} | ${cell(j.location||'Not stated')} | ${cell(ELIGIBILITY_LABELS[j.eligibility])} | ${j.posted_date||'Not stated'} | [Details](${href(withUtm(j.roliva_url,campaign))}) · [Apply](${href(j.apply_url)}) |`);
 return lines.join('\n');
}
export function renderReadme(payload,{list,baseUrl,paused=false}){
 const cfg=LISTS[list],home=withUtm(`${baseUrl}/`,cfg.campaign),source=exportUrl(baseUrl,list);
 const groups=groupByRole(payload.jobs);
 const legend=Object.entries(ELIGIBILITY_LABELS).filter(([k])=>list==='freshers-india'||k!=='india-location')
  .map(([k,label])=>`- **${label}**: ${{india:'the listing names India as an allowed country.','india-region':'the listing is remote within a named region of India.',apac:'the listing names APAC, Asia-Pacific or Asia.',worldwide:'the listing says worldwide, anywhere or global.','india-location':'the employer states the job is located in India (on-site or hybrid).'}[k]}`);
 const body=paused
  ?['> **This list is paused.** It could not be refreshed for more than three days, so the roles are hidden rather than shown out of date. It comes back automatically at the next successful update.']
  :payload.jobs.length?groups.flatMap(([label,rows])=>[`### ${cell(label)} (${rows.length})`,'',tableHtml(rows,cfg.campaign),''])
   :['No roles match right now. The list refreshes every day.'];
 return [
  `# ${cfg.heading}`,'',
  `${cfg.intro} Every role was confirmed open on the employer’s own hiring system within the last 72 hours.`,'',
  `**Last updated:** ${utc(payload.generated_at)} · **Roles:** ${paused?0:payload.jobs.length}`,'',
  '> **Read the full listing before you apply.** The employer, not this list, decides who is eligible.',
  '> Never pay anyone to apply for a job.','',
  '## How this list is made','',
  '- Roles come from employers’ public job boards on **Greenhouse, Lever and Ashby**, collected by [ROLIVA]('+href(home)+').',
  ...cfg.selection.map(s=>`- ${s}`),
  '- A role must have been seen open on the employer’s own system in the last 72 hours. Roles that close, whose apply link breaks, or that cannot be re-confirmed drop out at the next daily update. The git history is the archive.',
  '- **Posted** is the date the employer states. "Not stated" means the employer gave no date; it is never guessed.',
  '- Roles from Workday, SmartRecruiters and Workable boards are not included, because their terms either forbid this kind of reuse or have not been confirmed. Other sources are left out until checked.',
  '- No job descriptions, salaries or personal data are copied: only the title, company, location line, dates and links.',
  `- At most 300 roles, newest first. The full data is in [\`data.json\`](data.json), built from [ROLIVA’s public export](${href(source)}) by \`scripts/github-job-list.mjs\`. The tables are generated: please do not edit them by hand.`,
  '','**Eligibility labels**','',...legend,'',
  '## Roles','',...body,...(body.at(-1)===''?[]:['']),
  '## Disclaimer','',
  '- This list is generated automatically and may contain mistakes. An eligibility label repeats what the listing states; it is not legal or immigration advice, and a role may still need work authorisation, a local entity, or time-zone overlap. Check the full listing.',
  '- ROLIVA is not the employer and does not decide who is hired. **Apply** goes straight to the employer’s own application page.',
  '- Company names and trademarks belong to their owners. Being listed does not mean a company endorses this list or ROLIVA.','',
  '## Found a problem?','',
  'Open an issue with the role’s **Details** link and what is wrong (closed, wrong location, broken link). Please do not post personal information.','',
  '## About and licence','',
  `Maintained by [ROLIVA](${href(home)}), a job-search workspace built in India. The list is generated from ROLIVA’s public job data.`,'',
  '- **Job facts** (titles, employers, locations, dates and links) belong to their publishers. Each row links to the original posting.',
  '- **ROLIVA’s selection and arrangement** (the tables and `data.json`): [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Please credit “ROLIVA (rolivajobs.com)”.',
  '- **Scripts and workflow:** MIT. See `LICENSE`.',''
 ].join('\n');
}
export function renderData(payload,{list,paused=false}){
 return `${JSON.stringify({list,title:LISTS[list].heading,generated_at:payload.generated_at,source:payload.source??null,licence:{selection_and_arrangement:'CC-BY-4.0',job_facts:'Belong to their publishers; each row links to the original posting.'},paused,
  count:paused?0:payload.jobs.length,jobs:paused?[]:payload.jobs},null,1)}\n`;
}

// --- I/O ----------------------------------------------------------------------------------------------------------
export async function fetchExport(target,{fetchImpl=fetch}={}){
 const response=await fetchImpl(target,{headers:{accept:'application/json','user-agent':'roliva-github-job-list/1'},redirect:'error',signal:AbortSignal.timeout(FETCH_TIMEOUT_MS)});
 if(response.status!==200)throw new Error(`FETCH_STATUS_${response.status}`);
 if(!String(response.headers.get('content-type')||'').startsWith('application/json'))throw new Error('FETCH_NOT_JSON');
 const declared=Number(response.headers.get('content-length')||0);if(declared>MAX_RESPONSE_BYTES)throw new Error('FETCH_TOO_LARGE');
 const text=await response.text();if(Buffer.byteLength(text)>MAX_RESPONSE_BYTES)throw new Error('FETCH_TOO_LARGE');
 return JSON.parse(text);
}
const readJson=async path=>{try{return JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}};
const writeAtomic=async(path,text)=>{await writeFile(`${path}.tmp`,text);await rename(`${path}.tmp`,path);};

export async function run(argv,{fetchImpl=fetch,log=console.log,nowMs=Date.now()}={}){
 let opts;try{opts=parseArgs(argv);}catch(error){log(`${error.message}\n${usage}`);return 1;}
 const dataPath=join(opts.out,'data.json'),readmePath=join(opts.out,'README.md'),previous=await readJson(dataPath);
 if(opts.pauseHours!==undefined){
  // Stale-list guard: never leave rows up that nobody has re-checked for days.
  if(!previous||previous.paused||!(nowMs-Date.parse(previous.generated_at)>opts.pauseHours*3600000))return 0;
  const payload={generated_at:new Date(nowMs).toISOString(),source:previous.source,jobs:[]};
  await writeAtomic(readmePath,renderReadme(payload,{...opts,paused:true}));await writeAtomic(dataPath,renderData(payload,{list:opts.list,paused:true}));
  log(JSON.stringify({ok:true,paused:true,list:opts.list}));return 4;
 }
 let payload;
 try{
  payload=opts.input?JSON.parse(await readFile(opts.input,'utf8')):await fetchExport(exportUrl(opts.baseUrl,opts.list),{fetchImpl});
  validatePayload(payload,opts);
 }catch(error){log(JSON.stringify({ok:false,error:String(error.message||error).slice(0,200)}));return 2;}
 const before=previous&&!previous.paused?Number(previous.count)||0:0;
 if(before>=10&&payload.jobs.length<before*opts.minRatio){log(JSON.stringify({ok:false,error:'SHRINK_GUARD',before,after:payload.jobs.length}));return 3;}
 await mkdir(opts.out,{recursive:true});
 await writeAtomic(readmePath,renderReadme(payload,opts));await writeAtomic(dataPath,renderData(payload,opts));
 log(JSON.stringify({ok:true,list:opts.list,count:payload.jobs.length}));return 0;
}

if(import.meta.url===pathToFileURL(process.argv[1]||'').href)process.exitCode=await run(process.argv.slice(2));
