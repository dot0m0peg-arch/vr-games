import * as THREE from '../../vendor/three.module.min.js';
import RAPIER from '../../vendor/rapier/dist/rapier.mjs';
import { createPhysicsWorld } from '../dot3d/physics.js';
import { createBus } from '../dot3d/bus.js';
import { FINGERS, REST, makeHandRig, chain, targetCurls, fitCurls } from './hand-rig.js';
import { CLAIM_GAP, CLAIM_REACH, presentUsers, ownerOf, claimOf, newerClaim, validClaim, claimsOther } from './ownership.js';
import { edgesFor } from './edges.js';

export async function initPhysics() { await RAPIER.init(); }
const DEG=Math.PI/180;
const FIT_EVERY=3; // frames between finger refits while the grip still ramps (a settled hold is fitted once)
const EASE=14; // per second: a fist closes in about a tenth of a second
const FIT_REACH=.2; // m: colliders of the held body this far from the hand can meet a finger
const SCAN_EVERY=3; // frames between proximity scans for bodies another device simulates
const PHYSICS_KEYS=['physicsPose','physicsClaim','physicsSwing','physicsBroken','physicsStuck']; // record.data keys the stream writes
// A saved stick in a record (data.physicsStuck): {on, a, b, q, dir, d, m} as the core's stickState writes it.
const validStuck=s=>!!s&&typeof s==='object'&&typeof s.on==='string'&&s.on.length>0&&Array.isArray(s.a)&&s.a.length===3&&Array.isArray(s.b)&&s.b.length===3&&num4(s.q)&&Array.isArray(s.dir)&&s.dir.length===3&&[...s.a,...s.b,...s.dir].every(Number.isFinite)&&Number.isFinite(s.d)&&s.d>0;

// Record data without the streamed physics keys: what a real data change (blueprint, deck, fill) looks like.
const dataKeyOf=r=>{const d=r?.data;if(!d)return '';const o={};for(const k of Object.keys(d))if(!PHYSICS_KEYS.includes(k))o[k]=d[k];return JSON.stringify(o);};
const num7=a=>Array.isArray(a)&&a.length===7&&a.every(Number.isFinite);
const num4=a=>Array.isArray(a)&&a.length===4&&a.every(Number.isFinite);

// P1 local candidate: the same Room/SceneObjects/Interact path, with separate save storage.
// P4: several devices in one room. getUser() is our user id, getUsers() the room's users list (both from main.js, read
// each time because joining changes them). Every body has exactly one simulating owner (js/physics/ownership.js); here
// the bodies we own are simulated and streamed, the others are kinematic followers of their owner's stream.
export class PhysicsRoom {
  constructor({objects,room,send,scene,getUser=null,getUsers=null}) {
    this.objects=objects;this.room=room;this.send=send;this.scene=scene;
    this.getUser=typeof getUser==='function'?getUser:()=>'local';
    this.getUsers=typeof getUsers==='function'?getUsers:()=>[];
    this.bus=createBus();this.core=createPhysicsWorld(RAPIER,this.bus);
    this.entries=new Map();this.visuals=new Map();this.grabs=new Map();this.writing=false;this.saveTime=0;this.renderQ=new THREE.Quaternion();
    this.fingerState=new Map();
    this.ledger=new Map();this.owners=new Map();this.lastClaim=new Map();this.time=0;this.frame=0;this.claimed=0;
    // The floor is stone to the solver (hard, grippy) and grass to the effects (LOOK-BIBLE.md section 7: a landing throws green dust and flecks, not stone chips).
    this.core.add('__floor',{p:{x:0,y:-.1,z:0},fixed:true,shapes:[{p:{x:0,y:0,z:0},size:{x:4000,y:.2,z:4000},material:'stone',surface:'grass'}]});
    objects.physics=this;
    this.off=room.on('update',(r,patch,op)=>this.onUpdate(r,patch,op));
    this.offLoad=room.on('load',()=>{this.ledger.clear();});
    // Our own bodies hitting one another device simulates: take it over (rule in ownership.js), so what we knock flies here.
    this.offContact=this.bus.on('contact',e=>this.onContact(e));
    // A swing we simulate tore off: tell the room, so every device lets it go.
    this.offBreak=this.bus.on('break',({id})=>{if(this.mine(id)&&this.room.get(id))this.sendData(id,{physicsBroken:true},false);});
    // A weapon we simulate stuck in something (or came free): the record carries the stick, so the device that takes the
    // weapon over later, or a reload, sets the same joint again (ensureStuck). A re-set of what the record already says
    // writes nothing.
    this.offStick=this.bus.on('stick',({id})=>{
      const r=this.room.get(id);if(!r||!this.mine(id))return;
      const next=this.core.stickState(id);
      if(JSON.stringify(r.data?.physicsStuck??null)!==JSON.stringify(next))this.sendData(id,{physicsStuck:next},false);
    });
    this.offUnstick=this.bus.on('unstick',({id})=>{const r=this.room.get(id);if(r&&this.mine(id)&&r.data?.physicsStuck)this.sendData(id,{physicsStuck:null},false);});
  }
  me(){return this.getUser()??'local';}
  present(){return presentUsers(this.getUsers(),this.me());}
  has(id){return this.entries.has(id);}
  // A mounted swing (the dummy still on its post) is not a thing to pick up; once it has broken off it is.
  canGrab(id){return !!this.entries.get(id)&&!this.core.props.get(id).fixed&&!this.core.mounted(id);}
  remove(id){
    const e=this.entries.get(id);
    if(e){e.entry.physics=false;if(e.rig){this.core.remove(e.rig.baseId);this.restRig(e);}}
    this.core.remove(id);this.entries.delete(id);this.owners.delete(id);
  }
  // ---------- ownership ----------
  ownerOf(id){return ownerOf(this.room.get(id),{state:this.room.state,ledger:this.ledger,present:this.present(),me:this.me()});}
  mine(id){const e=this.entries.get(id);if(!e)return false;if(this.core.props.get(id)?.fixed)return true;return (this.owners.get(id)??this.ownerOf(id))===this.me();}
  // Recompute who simulates `id` and switch the body between simulated and followed when that changed.
  refreshOwner(id) {
    const e=this.entries.get(id),r=this.room.get(id);if(!e||!r)return null;
    const owner=this.ownerOf(id),was=this.owners.get(id);
    this.owners.set(id,owner);
    if(this.core.props.get(id)?.fixed)return owner;
    const ours=owner===this.me();
    if(ours&&this.core.kinematic(id)) {
      // Handover: start from where the stream had it, with the speed it was going.
      const vel=this.core.followVelocity(id);
      this.core.setKinematic(id,false,{linvel:vel});
    } else if(!ours&&!this.core.kinematic(id)) {
      this.core.setKinematic(id,true);
      this.followRecord(e,r);
    } else if(!ours&&was===undefined) this.followRecord(e,r);
    if(ours&&!e.rig)this.ensureStuck(id,r);
    return owner;
  }
  refreshOwners(){for(const id of this.entries.keys())this.refreshOwner(id);}
  // A weapon we simulate whose record says it is stuck in something, with no joint here yet (a reload, a handover, the
  // struck body rebuilt): set the saved stick again once the struck body exists here.
  ensureStuck(id,r) {
    const saved=r?.data?.physicsStuck;
    if(!validStuck(saved)||this.core.stuck(id)||!this.core.props.has(saved.on)||this.core.kinematic(saved.on))return false;
    return !!this.core.stickAt(id,saved.on,saved);
  }
  // Read-only stick state of a weapon {onId, depth, hold, tug, material, at} or null, for checks and the HUD.
  stuck(id){return this.core.stuck(id);}
  // Claim `id` for this device: the ledger says so at once (so the body is simulated here right away), the room learns
  // through a normal data patch (a stale pose stream can never undo it: the newest claim wins, ownership.js).
  claim(id,{force=false}={}) {
    const r=this.room.get(id);if(!r||!this.entries.has(id)||this.core.props.get(id)?.fixed)return false;
    if(this.mine(id))return false;
    const last=this.lastClaim.get(id);
    if(!force&&last!==undefined&&this.time-last<CLAIM_GAP)return false;
    this.lastClaim.set(id,this.time);
    const n=(claimOf(r,this.ledger)?.n??0)+1,c={user:this.me(),n};
    this.ledger.set(id,c);this.claimed++;
    this.sendData(id,{physicsClaim:c},false);
    this.refreshOwner(id);
    return true;
  }
  // A data patch that keeps the record's other data and the ledger's claim.
  sendData(id,extra,transient) {
    const r=this.room.get(id);if(!r)return;
    const claim=claimOf(r,this.ledger);
    const data={...r.data,...(claim?{physicsClaim:claim}:{}),...extra};
    this.writing=true;
    try{this.send({t:'set',id,patch:{data},...(transient?{transient:true}:{})});}finally{this.writing=false;}
  }
  // Point the follower at the record's own pose (what a newly seen body starts from; the owner's stream refines it).
  followRecord(e,r) {
    if(e.rig){const sw=r.data?.physicsSwing;if(num7(sw))this.core.follow(r.id,{p:{x:sw[0],y:sw[1],z:sw[2]},q:{x:sw[3],y:sw[4],z:sw[5],w:sw[6]}});return;}
    const q=num4(r.data?.physicsPose)?new THREE.Quaternion().fromArray(r.data.physicsPose).normalize():new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),r.ry||0);
    this.core.follow(r.id,{p:{x:r.p[0],y:r.p[1],z:r.p[2]},q});
  }
  onUpdate(r,patch,op) {
    if(this.writing)return;
    // Anyone's claim, in a claim patch or riding a pose stream, is remembered; the newest wins everywhere.
    const c=validClaim(r.data?.physicsClaim);
    if(c&&'data' in patch)this.ledger.set(r.id,newerClaim(this.ledger.get(r.id),c));
    const e=this.entries.get(r.id); if(!e)return;
    // A real shape change (scale, blueprint, deck) rebuilds the body from the rebuilt object next sync.
    if('s' in patch||('data' in patch&&dataKeyOf(r)!==e.dataKey)){this.remove(r.id);if(e.rig){this.objects._applyRecordPose?.(e.entry);e.entry.tween=null;}return;}
    if(e.rig) {
      // A rig stands where its record says: a move re-plants it there (next sync) instead of moving the bodies.
      if('p' in patch||'ry' in patch){this.remove(r.id);this.objects._applyRecordPose?.(e.entry);e.entry.tween=null;return;}
      if(!this.mine(r.id)) {
        if(r.data?.physicsBroken&&this.core.mounted(r.id))this.core.unmount(r.id);
        if('data' in patch)this.followRecord(e,r);
      }
      return;
    }
    if(this.mine(r.id)) {
      if('p' in patch||'ry' in patch) {
        const q=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),r.ry||0);
        e.body.setTranslation(new THREE.Vector3().fromArray(r.p),true);e.body.setRotation(q,true);
        e.body.setLinvel({x:0,y:0,z:0},true);e.body.setAngvel({x:0,y:0,z:0},true);
      }
    } else if('p' in patch||'ry' in patch||'data' in patch) this.followRecord(e,r);
  }
  // A contact between a body of ours (a hand, or anything we simulate) and a body another device simulates: the side
  // the rule names claims it, so the thing we knocked is knocked here, not frozen on its owner's last pose.
  onContact(e) {
    const handles=Array.isArray(e?.colliders)?e.colliders:[];if(handles.length!==2)return;
    const sides=handles.map(h=>this.sideOf(h));
    for(let i=0;i<2;i++) {
      const a=sides[i],b=sides[1-i];
      if(!b||b.kind!=='theirs'||!a||a.kind==='theirs'||a.kind==='fixed')continue;
      if(claimsOther(a.id,b.id,{hand:a.kind==='hand'}))this.claim(b.id);
    }
  }
  // What a collider handle belongs to: {kind:'hand'|'mine'|'theirs'|'fixed', id}.
  sideOf(handle) {
    const c=this.core.world.getCollider(handle);const body=c?.parent();if(!body)return null;
    for(const [name,h] of this.core.hands)if(h.body.handle===body.handle)return {kind:'hand',id:name};
    for(const [id,p] of this.core.props) {
      if(p.body.handle!==body.handle)continue;
      if(p.fixed)return {kind:'fixed',id};
      return {kind:this.entries.has(id)&&!this.mine(id)?'theirs':'mine',id};
    }
    return null;
  }
  // Bodies another device simulates that one of our hands (or what it holds) has come near: claim them before touching.
  scanClaims() {
    const near=[];
    for(const [name,h] of this.core.hands) {
      near.push({p:new THREE.Vector3().copy(h.body.translation()),box:null});
      if(h.joint&&h.id)near.push({p:null,box:this.objects.bounds(h.id)});
    }
    if(!near.length)return;
    const box=new THREE.Box3(),gap=new THREE.Vector3();
    for(const id of this.entries.keys()) {
      if(this.mine(id))continue;
      const last=this.lastClaim.get(id);if(last!==undefined&&this.time-last<CLAIM_GAP)continue;
      this.objects.bounds(id,box);if(box.isEmpty())continue;
      for(const n of near) {
        let d;
        if(n.p)d=box.distanceToPoint(n.p);
        else if(n.box&&!n.box.isEmpty()){gap.set(Math.max(0,box.min.x-n.box.max.x,n.box.min.x-box.max.x),Math.max(0,box.min.y-n.box.max.y,n.box.min.y-box.max.y),Math.max(0,box.min.z-n.box.max.z,n.box.min.z-box.max.z));d=gap.length();}
        else continue;
        if(d<=CLAIM_REACH){this.claim(id);break;}
      }
    }
  }
  // Read-only ownership table for checks and the HUD: [{id, owner, mine, kinematic, fixed, claim}].
  ownership() {
    const out=[];
    for(const [id] of this.entries){const p=this.core.props.get(id);out.push({id,owner:p?.fixed?null:(this.owners.get(id)??null),mine:this.mine(id),kinematic:!!p?.kinematic,fixed:!!p?.fixed,claim:claimOf(this.room.get(id),this.ledger)});}
    return out;
  }
  // Rigged part (js/physics/rig.js): the base shapes become a fixed body at the record pose, the swing shapes a dynamic
  // body with its origin at the pivot, hung on the base by the core's mount (ball joint + spring, breaks past breakAt).
  // A record whose data says physicsBroken is not mounted: its top is already off, on every device alike.
  addRig(id,entry,rig) {
    const s=entry.record.s||1,w=entry.wrapper;
    const scaled=list=>list.map(sh=>({...sh,p:{x:sh.p.x*s,y:sh.p.y*s,z:sh.p.z*s},size:{x:sh.size.x*s,y:sh.size.y*s,z:sh.size.z*s}}));
    const pivot=new THREE.Vector3(rig.pivot.x*s,rig.pivot.y*s,rig.pivot.z*s);
    const q=w.quaternion.clone(),anchor=pivot.clone().applyQuaternion(q).add(w.position);
    const baseId=id+'#base';
    this.core.add(baseId,{p:w.position,q,fixed:true,shapes:scaled(rig.shapes.base)});
    const body=this.core.add(id,{p:anchor,q,fixed:false,shapes:scaled(rig.shapes.swing).map(sh=>({...sh,p:{x:sh.p.x-pivot.x,y:sh.p.y-pivot.y,z:sh.p.z-pivot.z}}))});
    if(!entry.record.data?.physicsBroken)this.core.mount(id,baseId,{anchor,hz:rig.hz,settle:rig.settle,breakAt:rig.breakAt});
    entry.physics=true;entry.tween=null;entry.fly=null;
    this.entries.set(id,{entry,body,lastSleep:false,dataKey:dataKeyOf(entry.record),rig:{baseId,swing:rig.swing,pivot:new THREE.Vector3(rig.pivot.x,rig.pivot.y,rig.pivot.z)}});
  }
  // The swing group back at its built pose (the part is drawn whole again when physics lets go of it).
  restRig(e){const g=e.rig.swing;g.position.copy(e.rig.pivot);g.quaternion.identity();g.scale.setScalar(1);e.entry.bFrame=-1;}
  // Pose the swing group from the stepped swing body, in the inner object's frame (the wrapper carries pose and scale).
  poseRig(e,prev,p,q,alpha) {
    const t=this.rigT??(this.rigT={p:new THREE.Vector3(),q:new THREE.Quaternion(),m:new THREE.Matrix4(),inv:new THREE.Matrix4(),s:new THREE.Vector3()});
    const inner=e.entry.inner,g=e.rig.swing,s=e.entry.record.s||1;
    t.p.copy(prev.p).lerp(p,alpha);t.q.copy(prev.q).slerp(this.renderQ.copy(q),alpha);
    inner.updateWorldMatrix(true,false);
    t.inv.copy(inner.matrixWorld).invert();
    t.m.compose(t.p,t.q,t.s.set(s,s,s)).premultiply(t.inv).decompose(g.position,g.quaternion,g.scale);
    e.entry.bFrame=-1;
  }
  // Read-only rig state for checks and the HUD: {mounted, lean (rad), maxLean, baseId} or null.
  rig(id){const e=this.entries.get(id);if(!e?.rig)return null;const m=this.core.mounts.get(id);return {mounted:!!m,lean:m?.lean??null,maxLean:m?.maxLean??null,baseId:e.rig.baseId};}
  sync() {
    for(const [id,e] of this.entries) {
      const entry=this.objects.entries.get(id);
      if(!entry||entry!==e.entry||entry.removing)this.remove(id);
    }
    for(const [id,entry] of this.objects.entries) {
      if(this.entries.has(id)||entry.removing||entry.phasing)continue;
      // Animated characters/drawings retain their original behavior until their rig exists (P3 covers rigged parts).
      if(entry.part==='drawing'||entry.part==='doodle'||entry.hooks.update||entry.behavior||entry.meta.screen)continue;
      const rig=entry.wrapper.userData.physicsRig;
      if(rig){this.addRig(id,entry,rig);this.refreshOwner(id);continue;}
      const raw=entry.wrapper.userData.physicsShapes;
      if(!raw?.length)continue;
      const scale=entry.record.s||1;
      const shapes=raw.map(s=>({...s,p:{x:s.p.x*scale,y:s.p.y*scale,z:s.p.z*scale},
        size:{x:s.size.x*scale,y:s.size.y*scale,z:s.size.z*scale},hollow:entry.meta.surface!==undefined}));
      const fixed=!!entry.meta.fixed||!!entry.meta.heavy||Math.max(...(entry.meta.size??[1,1,1]))*scale>3;
      const q=entry.wrapper.quaternion.clone();
      const saved=entry.record.data?.physicsPose;
      if(Array.isArray(saved)&&saved.length===4&&saved.every(Number.isFinite))q.fromArray(saved).normalize();
      // What bites on this part (a sword's tip, an axe's bit): js/physics/edges.js, scaled with the record.
      const edges=fixed?[]:edgesFor(entry.part,entry.meta,scale);
      const body=this.core.add(id,{p:entry.wrapper.position,q,fixed,shapes,edges});
      entry.physics=true;entry.tween=null;entry.fly=null;
      this.entries.set(id,{entry,body,lastSleep:false,dataKey:dataKeyOf(entry.record)});
      this.refreshOwner(id);
    }
  }
  // poses: {left,right} controller poses. inputs (optional): {left,right} of {trigger 0..1, squeeze 0..1, thumb bool}
  // from the controller; without them a holding hand closes and a free hand rests open.
  setHands(poses,inputs=null) {
    for(const name of ['left','right']) {
      this.core.targetHand(name,poses?.[name]);
      if(!this.core.hands.has(name))this.finishGrab(name);
      this.updateFingers(name,this.core.hands.get(name),inputs?.[name]);
    }
  }
  // Finger curls for one hand: targets from the controller (a holding hand closes fully) and, on a held body, each
  // finger fitted to stop where it meets the thing. The fit is measured through the hold joint's own hand-to-body
  // relation (not the bodies' momentary poses, which a swinging load pulls a centimetre apart), so it is refitted only
  // when the hold changes, while the grip still ramps, or when the targets move. The shown curls ease in update(dt).
  updateFingers(name,h,input) {
    let f=this.fingerState.get(name);
    if(!f){f={target:FINGERS.map(()=>REST),fitted:FINGERS.map(()=>REST),curl:FINGERS.map(()=>REST),against:null,fitTarget:null,age:0};this.fingerState.set(name,f);}
    const holding=!!(h?.joint&&h.frame&&h.id&&this.core.props.has(h.id));
    f.target=targetCurls(input,holding);
    if(!holding){f.fitted=f.target;f.against=null;f.fitTarget=null;return f;}
    const moved=!f.fitTarget||f.fitTarget.some((t,i)=>Math.abs(t-f.target[i])>.02);
    const ramping=!!h.align&&++f.age>=FIT_EVERY,settled=f.wasAligning&&!h.align; // one last fit on the finished grip
    f.wasAligning=!!h.align;
    if(f.against===h.id&&!moved&&!ramping&&!settled)return f;
    const e=this.core.props.get(h.id),bp=new THREE.Vector3().copy(e.body.translation()),bq=new THREE.Quaternion().copy(e.body.rotation());
    const anchor=new THREE.Vector3().copy(h.frame.anchor),frame=new THREE.Quaternion().copy(h.frame.frame);
    const clearance=this.core.clearanceProbe(h.id,anchor.clone().applyQuaternion(bq).add(bp),FIT_REACH);
    const world=new THREE.Vector3();
    // hand-space point -> body-local through the joint (hand.rot == body.rot * frame; the anchor sits at the hand origin) -> world
    f.fitted=fitCurls(f.target,name,(p,r)=>clearance(world.copy(p).applyQuaternion(frame).add(anchor).applyQuaternion(bq).add(bp))-r*.5);
    f.against=h.id;f.fitTarget=f.target.slice();f.age=0;
    return f;
  }
  // Ease the shown curls toward the fitted ones and pose the hand visuals on the stepped bodies.
  updateHands(dt) {
    const k=Math.min(1,Math.max(0,dt)*EASE);
    for(const name of ['left','right']) {
      const f=this.fingerState.get(name),h=this.core.hands.get(name);
      if(f)f.curl=f.curl.map((c,i)=>c+(f.fitted[i]-c)*k);
      if(!this.scene)continue;
      let vis=this.visuals.get(name);
      if(!vis) {
        vis={rig:makeHandRig(name),ghost:makeHandRig(name,{opacity:.22})};
        this.scene.add(vis.rig.root,vis.ghost.root);this.visuals.set(name,vis);
      }
      vis.rig.root.visible=!!h;vis.ghost.root.visible=!!h&&new THREE.Vector3().copy(h.body.translation()).distanceTo(h.target.p)>.04;
      if(!h)continue;
      vis.rig.root.position.copy(h.body.translation());vis.rig.root.quaternion.copy(h.body.rotation());
      vis.ghost.root.position.copy(h.target.p);vis.ghost.root.quaternion.copy(h.target.q);
      if(f){vis.rig.setCurls(f.curl);vis.ghost.setCurls(f.curl);}
    }
  }
  // Read-only finger state {target,fitted,curl,against} of one hand, for checks and the HUD.
  fingers(name){return this.fingerState.get(name)??null;}
  // World-space sample points of a hand's fingers at their shown curls: [{finger,p:THREE.Vector3,r}] (what the fit tested).
  fingerPoints(name) {
    const h=this.core.hands.get(name),f=this.fingerState.get(name);if(!h||!f)return [];
    const hp=new THREE.Vector3().copy(h.body.translation()),hq=new THREE.Quaternion().copy(h.body.rotation());
    return FINGERS.flatMap((finger,i)=>chain(finger,f.curl[i],name).map(s=>({finger,p:s.p.applyQuaternion(hq).add(hp),r:s.r})));
  }
  // grip: the part's meta.grip {p:[x,y,z] part-local handle point, r:[deg,deg,deg] XYZ} or null. Scaled by the record here;
  // the core turns the object into that pose through its joint (see physics.js grab).
  gripFor(id,grip) {
    if(!Array.isArray(grip?.p)||!Array.isArray(grip?.r))return null;
    const s=this.entries.get(id)?.entry.record.s||1;
    const q=new THREE.Quaternion().setFromEuler(new THREE.Euler((+grip.r[0]||0)*DEG,(+grip.r[1]||0)*DEG,(+grip.r[2]||0)*DEG));
    return {anchor:{x:(+grip.p[0]||0)*s,y:(+grip.p[1]||0)*s,z:(+grip.p[2]||0)*s},q:{x:q.x,y:q.y,z:q.z,w:q.w}};
  }
  grab(hand,id,pose,{distance=false,grip=null}={}) {
    this.core.targetHand(hand,pose);
    const e=this.entries.get(id),h=this.core.hands.get(hand);
    if(!e||!h)return false;
    // Taking hold of what another device simulates: it is ours from this moment (the attach that follows seals it).
    if(!this.mine(id)){this.claim(id,{force:true});if(!this.mine(id))return false;}
    const box=this.objects.bounds(id);
    const palm=new THREE.Vector3().copy(h.body.translation());
    const want=this.gripFor(id,grip);
    let ok;
    if(box&&box.distanceToPoint(palm)>.25) {
      if(!distance||box.distanceToPoint(palm)>12)return false;
      ok=this.core.pull(hand,id,box.clampPoint(palm,new THREE.Vector3()),want);
    }else ok=this.core.grab(hand,id,want);
    if(ok)this.grabs.set(hand,id);
    return ok;
  }
  // The core dropped this hand's hold on its own (pull timed out, tracking lost, the body went to another device): drop
  // the record, or hand it over when the other hand still holds it. Never drop what another user's hand holds.
  finishGrab(hand) {
    const id=this.grabs.get(hand);this.grabs.delete(hand);
    if(!id||!this.entries.has(id)||!this.room.get(id))return;
    const attach=this.room.get(id).attach;
    if(attach&&attach.user!==this.me())return;
    const rest=this.holders(id).filter(other=>other!==hand);
    if(rest.length)this.commitHandoff(id,rest[0],hand);else this.commitRelease(id);
  }
  holders(id){return this.core.holders(id);}
  holds(hand,id){return !!id&&this.core.hands.get(hand)?.id===id;}
  release(hand){this.grabs.delete(hand);return this.core.release(hand);}
  commitRelease(id) {
    this.writing=true;
    try{this.send({t:'set',id,patch:{...this.posePatch(id),attach:null,onto:null}});}finally{this.writing=false;}
  }
  // Two hands held it and the hand the record is attached to let go: the attach moves to the hand still holding; nothing drops.
  commitHandoff(id,toHand,fromHand=null) {
    const attach=this.room.get(id)?.attach;
    if(!attach||attach.hand===toHand||(fromHand&&attach.hand!==fromHand))return false;
    this.writing=true;
    try{this.send({t:'set',id,patch:{attach:{...attach,hand:toHand}}});}finally{this.writing=false;}
    return true;
  }
  // The streamed pose of a body we simulate. It carries the ledger's claim, so the record converges on it.
  posePatch(id) {
    const e=this.entries.get(id);if(!e||e.rig)return {}; // a rig's record stays where it was planted
    const p=e.body.translation(),q=e.body.rotation(),r=this.room.get(id),claim=claimOf(r,this.ledger);
    return {p:[p.x,p.y,p.z],ry:Math.atan2(2*(q.w*q.y+q.x*q.z),1-2*(q.y*q.y+q.x*q.x)),
      data:{...e.entry.record.data,...(claim?{physicsClaim:claim}:{}),physicsPose:[q.x,q.y,q.z,q.w]}};
  }
  update(dt) {
    this.sync();this.refreshOwners();
    this.time+=dt;
    if(++this.frame%SCAN_EVERY===0)this.scanClaims();
    const alpha=this.core.advance(dt);this.saveTime+=dt;
    for(const [hand,id] of this.grabs)if(this.core.hands.get(hand)?.id!==id)this.finishGrab(hand);
    const save=this.saveTime>=1/15;if(save)this.saveTime=0;
    for(const [id,e] of this.entries) {
      const prop=this.core.props.get(id),prev=prop.previous,p=e.body.translation(),q=e.body.rotation();
      const ours=!prop.kinematic;
      if(e.rig) {
        this.poseRig(e,prev,p,q,alpha);
        // The swing's pose streams while it moves (and once more as it comes to rest), for the devices following it.
        if(ours&&!prop.fixed) {
          const sleep=e.body.isSleeping();
          if((save&&!sleep)||sleep!==e.lastSleep)this.sendData(id,{physicsSwing:[p.x,p.y,p.z,q.x,q.y,q.z,q.w]},!sleep);
          e.lastSleep=sleep;
        }
        continue;
      }
      if(ours) {
        const sleep=e.body.isSleeping();
        if(!prop.fixed&&((save&&!sleep)||sleep!==e.lastSleep)) {
          this.writing=true;
          try{this.send({t:'set',id,patch:this.posePatch(id),transient:!sleep});}finally{this.writing=false;}
        }
        e.lastSleep=sleep;
      }
      e.entry.wrapper.position.copy(prev.p).lerp(p,alpha);
      e.entry.wrapper.quaternion.copy(prev.q).slerp(this.renderQ.copy(q),alpha);e.entry.bFrame=-1;
    }
    this.updateHands(dt);
  }
  dispose(){this.off();this.offLoad();this.offContact();this.offBreak();this.offStick();this.offUnstick();for(const id of [...this.entries.keys()])this.remove(id);this.core.dispose();for(const vis of this.visuals.values()){vis.rig.dispose();vis.ghost.dispose();}this.visuals.clear();this.fingerState.clear();this.bus.clear();}
}
