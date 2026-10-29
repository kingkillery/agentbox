import {createContext,useContext,useEffect,useRef,useState,type ReactNode} from 'react';
import {api} from '../api';
import {onPhone} from '../phone-screen';
import {pollEvery} from '../phone-polls';
import {TaskTerminal} from './TaskTerminal';
type Update={engine:string;state:string;message?:string;installed?:string;latest?:string};
const Context=createContext<{updates:Record<string,Update>;start:(engine:string)=>void;setup:(engine:string)=>void}>({updates:{},start:()=>{},setup:()=>{}});
export const AgentUpdatesContext=Context;
export const useAgentUpdates=()=>useContext(Context);
export function AgentUpdates({children}:{children:ReactNode}){
 const [updates,setUpdates]=useState<Record<string,Update>>({});
 const [panel,setPanel]=useState<string|null>(null);
 const [ready,setReady]=useState(false);
 const [revision,setRevision]=useState(0);
 const [panelSetup,setPanelSetup]=useState(false);
 const busy=useRef(new Set<string>()),refreshed=useRef(0),lastState=useRef<Record<string,string>>({});
 const save=(u:Update)=>{if(u?.engine)setUpdates(v=>({...v,[u.engine]:u}));};
 useEffect(()=>{
  let live=true,checking=false;
  const check=async()=>{
   if(checking)return;checking=true;
   try{
    for(const engine of ['ompk','claude','codex'])try{const u=await api.agentUpdate(engine,'check');if(live)save(u);}catch{}
    if(Date.now()-refreshed.current>3600000){refreshed.current=Date.now();await Promise.allSettled(['claude','codex'].map(e=>api.agentUpdate(e,'refresh')));if(live)window.dispatchEvent(new Event('agent-models-changed'));}
   }finally{checking=false;}
  };
  void check();const timer=setInterval(check,3600000);window.addEventListener('focus',check);
  return()=>{live=false;clearInterval(timer);window.removeEventListener('focus',check);};
 },[]);
 useEffect(()=>{
  let live=true;
  const poll=async()=>{
    for(const engine of ['ompk','claude','codex'])try{
    const u=await api.agentUpdate(engine,'status');if(!live)continue;
    if(lastState.current[engine]==='running'&&u.state==='current')window.dispatchEvent(new Event('agent-models-changed'));
    lastState.current[engine]=u.state;save(u);
   }catch{}
  };
  // Every second on a desktop; a phone pays per question (../phone-polls).
  const timer=setInterval(poll,pollEvery(1000,onPhone()));return()=>{live=false;clearInterval(timer);};
 },[]);
 const start=async(engine:string)=>{
  setPanel(engine);setPanelSetup(false);
  if(updates[engine]?.state==='running'){setReady(true);return;}
  if(busy.current.has(engine))return;
  busy.current.add(engine);setReady(false);
  try{const u=await api.agentUpdate(engine,'start');save(u);lastState.current[engine]=u.state;setRevision(v=>v+1);setReady(u.state==='running');if(u.state==='current')window.dispatchEvent(new Event('agent-models-changed'));}
  catch(e){save({engine,state:'failed',message:e instanceof Error?e.message:String(e)});}
  finally{busy.current.delete(engine);}
 };
 // THE SAME PANEL FOR THE AGENT'S OWN SETUP. ompk's `setup` wizard needs a
 // real terminal, so a "Sign in" press opens this and the wizard runs in it.
 const setup=async(engine:string)=>{
  setPanel(engine);setPanelSetup(true);
  if(busy.current.has(engine))return;
  busy.current.add(engine);setReady(false);
  try{const u=await api.agentUpdate(engine,'setup');save(u);setRevision(v=>v+1);setReady(u.state==='running');}
  catch(e){save({engine,state:'failed',message:e instanceof Error?e.message:String(e)});}
  finally{busy.current.delete(engine);}
 };
 const u=panel?updates[panel]:null;
 // The panel docks BELOW the app in one column, so opening it shrinks the app
 // rather than covering its bottom. The wrapper is always drawn: wrapping only
 // while the panel is open would remount the whole app on every click.
 return <Context.Provider value={{updates,start,setup}}><div className="agent-update-host"><div className="agent-update-app">{children}</div>{panel&&
  <section className="agent-update-panel" role="dialog" aria-label={`${panelSetup?'Set up':'Update'} ${panel==='codex'?'Codex':panel==='ompk'?'ompk':'Claude Code'}`} onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();setPanel(null);}}}>
   <header className="agent-update-heading"><span>{panelSetup?'Set up':'Update'} {panel==='codex'?'Codex':panel==='ompk'?'ompk':'Claude Code'}</span><button type="button" onClick={()=>setPanel(null)} aria-label="Hide update terminal">×</button></header>
   {u?.message&&<div className="agent-update-status" role="status">{u.message} {u.state==='failed'&&<button type="button" onClick={()=>void start(panel)}>Retry</button>}</div>}
   {!ready&&!u?.message&&<div className="agent-update-status" role="status">Checking the installed agent…</div>}
   {ready&&<TaskTerminal key={`${panel}:${revision}`} product="@agent-update" id={panel} startOpen commandSession/>}
  </section>}</div></Context.Provider>;
}
