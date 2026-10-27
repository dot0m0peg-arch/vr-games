// P5 weapons that stick: a blade driven edge-first into straw or wood hard enough stays in it (js/dot3d/physics.js stick,
// js/physics/edges.js for what bites), it stays when the hand lets go, a hard tug works it free, the record carries the
// stick so a reload or another device sets the same joint again (js/physics/sync.js). Owner, Oct 23 2026 (Codex
// transmitter): "If I smack a wall with my sword, it should put an axe mark into the wall. It should do something, or it
// should stick. The axe should stick maybe. The world should respond as the world would really respond." Claude (Command), Oct 26 2026.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.min.js';
import { Room } from '../js/room.js';
import { SceneObjects } from '../js/world/objects.js';
import * as build from '../js/parts/build/index.js';
import { Interact } from '../js/play/interact.js';
import { PhysicsRoom, initPhysics } from '../js/physics/sync.js';
import { createHitEffects } from '../js/physics/hits.js';
import { EDGES, edgesFor } from '../js/physics/edges.js';
await initPhysics();
build.setPhysicsColliders(true);
const DEG=Math.PI/180;
const record=(id,part,p,extra={})=>({id,part,p,ry:0,s:1,label:part,...extra});
const FLAT=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),-90*DEG);
const flat={physicsPose:[FLAT.x,FLAT.y,FLAT.z,FLAT.w]};
const vec=o=>new THREE.Vector3(o.x,o.y,o.z),quat=o=>new THREE.Quaternion(o.x,o.y,o.z,o.w);
const wall=(mat)=>({blueprint:{name:mat+' wall',size:[5,3,.1],parts:[{shape:'box',p:[0,1.5,0],s:[5,3,.1],mat,color:'#818b91'}]}});
function setup(records) {
  const scene=new THREE.Scene(),room=new Room(),ops=[];
  const objects=new SceneObjects({scene,room,build});
  const send=op=>{ops.push(op);room.apply(op,{local:true});};
  const physics=new PhysicsRoom({objects,room,send});
  room.load({objects:Object.fromEntries(records.map(r=>[r.id,r])),order:records.map(r=>r.id),env:{time:'day'}});
  physics.sync();
  const interact=new Interact({objects,room,send,getUser:()=> 'local',metaOf:build.metaOfRecord});
  const contacts=[],sticks=[],unsticks=[],pulses=[];
  physics.bus.on('contact',e=>contacts.push(e));physics.bus.on('stick',e=>sticks.push(e));physics.bus.on('unstick',e=>unsticks.push(e));
  const fx=createHitEffects({bus:physics.bus,core:physics.core,sfx:null,haptic:(hand,intensity,ms)=>{pulses.push({hand,intensity,ms,time:physics.core.contacts.stats().time});return true;}});
  const tick=(n,hands={})=>{for(let i=0;i<n;i++){objects.update(1/90,i/90);physics.setHands(hands);physics.update(1/90);}};
  return {scene,room,objects,physics,interact,tick,contacts,sticks,unsticks,pulses,fx,ops,dispose(){fx.dispose();physics.dispose();objects.dispose();}};
}
const tipOf=(s,id='sword')=>{const b=s.physics.entries.get(id).body;return new THREE.Vector3(0,1,0).applyQuaternion(quat(b.rotation())).add(vec(b.translation()));};
const handPos=(s,hand='right')=>vec(s.physics.core.hands.get(hand).body.translation());
const pose=(x,y,z)=>({p:new THREE.Vector3(x,y,z),q:new THREE.Quaternion()});
// Pick the weapon up off the floor (it lies flat at the player's feet), let the grip settle, raise it pointing -z at height y.
function arm(s,id='sword',y=1.3) {
  const hand=pose(0,1.1,0);
  s.physics.setHands({right:hand});
  assert.equal(s.interact.grab('right',{point:hand.p,quat:hand.q}),id);
  s.tick(120,{right:hand});
  const raised=pose(0,y,-.1);
  s.tick(90,{right:raised});
  return raised;
}
const DUMMY_Z=-1.5, FRONT=DUMMY_Z+.19; // the straw body's front, roughly
const thrust=()=>pose(0,1.3,-.8); // the controller jumps 0.7 m forward: the tip goes through the straw
const back=()=>pose(0,1.3,-.45);  // and 0.35 m back: a hard tug

test('edges: swords, daggers, spears bite by the tip, axes by the bit; blunt parts never; a blueprint declares its own; scaled with the record',()=>{
  const sword=edgesFor('sword');
  assert.equal(sword.length,1);assert.deepEqual(sword[0].dir,{x:0,y:1,z:0});assert.ok(sword[0].p.y>1&&sword[0].r>.05);
  assert.deepEqual(edgesFor('axe')[0].dir,{x:1,y:0,z:0},'an axe bites toward +X, where its bit is built');
  assert.equal(edgesFor('battle axe').length,2,'a double axe has two bits');
  assert.deepEqual(edgesFor('battle axe').map(e=>e.dir.x),[1,-1]);
  for(const blunt of ['baseball bat','staff','war hammer','mace','wooden sword','shield','crate','training dummy','ball'])assert.deepEqual(edgesFor(blunt,build.metaOfRecord(record('x',blunt,[0,0,0]))),[],blunt+' never sticks');
  assert.ok(Object.keys(EDGES).includes('sword')&&Object.keys(EDGES).includes('axe'));
  const twice=edgesFor('Sword',null,2);
  assert.ok(Math.abs(twice[0].p.y-2*sword[0].p.y)<1e-9&&Math.abs(twice[0].r-2*sword[0].r)<1e-9&&twice[0].dir.y===1,'point and reach scale, the direction does not');
  const bp={name:'pitchfork',size:[.3,1.6,.1],holdable:true,edge:{p:[0,1.6,0],dir:[0,2,0],r:.08},parts:[{shape:'box',p:[0,.8,0],s:[.04,1.6,.04],mat:'wood'}]};
  const meta=build.metaOfRecord(record('f','pitchfork',[0,0,0],{data:{blueprint:bp}}));
  assert.deepEqual(edgesFor('pitchfork',meta),[{p:{x:0,y:1.6,z:0},dir:{x:0,y:1,z:0},r:.08}],'meta.edge from a blueprint, direction normalised');
  assert.deepEqual(edgesFor('pitchfork',{edges:[{p:[0,1,0],dir:[0,0,0]},{p:[1,'x',0],dir:[1,0,0]}]}),[],'broken edges are ignored');
  const sw=setup([record('sword','sword',[.04,1.1,0],{data:flat}),record('bat','baseball bat',[.6,1.1,0],{data:flat})]);
  try {
    assert.equal(sw.physics.core.props.get('sword').edges.length,1,'the sword body carries its edge');
    assert.equal(sw.physics.core.props.get('bat').edges.length,0,'the bat carries none');
  } finally { sw.dispose(); }
});

test('a held sword thrust into the dummy sticks: a fixed joint sunk by the hit, the hand feels it, the record carries it; pulling the controller back leaves the hand hanging on the blade until a hard tug works it free',()=>{
  const s=setup([record('sword','sword',[.04,1.1,0],{data:flat}),record('dummy','training dummy',[0,0,DUMMY_Z])]);
  try {
    arm(s);
    assert.equal(s.sticks.length,0);assert.equal(s.physics.stuck('sword'),null);
    const tip0=tipOf(s);
    assert.ok(tip0.z<-.9&&tip0.z>FRONT,'blade points at the dummy, tip short of the straw: '+tip0.toArray().map(v=>v.toFixed(2)));
    let stuckAt=null;
    for(let i=0;i<60&&stuckAt===null;i++){s.tick(1,{right:thrust()});if(s.physics.stuck('sword'))stuckAt=i;}
    assert.ok(stuckAt!==null&&stuckAt<30,'stuck within a third of a second of the thrust: '+stuckAt);
    const hit=s.contacts.find(c=>c.materials.includes('soft'));
    assert.ok(hit&&hit.impulse>=8&&Number.isInteger(hit.striker)&&hit.striker>=0&&hit.striker<=1,`a real thrust with a striker index: ${hit?.impulse.toFixed(1)} N*s, striker ${hit?.striker}`);
    assert.equal(s.sticks.length,1,'one stick event');
    const ev=s.sticks[0];
    assert.deepEqual(Object.keys(ev).sort(),['depth','hands','hold','id','impulse','material','normal','onId','point','time']);
    assert.ok(ev.id==='sword'&&ev.onId==='dummy'&&ev.material==='soft'&&ev.impulse>=8&&ev.depth>=.04&&ev.depth<=.12&&ev.hold>100&&ev.normal.z<-.9,'the event says what bit what: '+JSON.stringify({...ev,point:undefined,normal:undefined}));
    assert.deepEqual(ev.hands,['right'],'the hand that held it');
    assert.ok(s.pulses.some(p=>p.hand==='right'&&p.intensity===.9&&p.ms===90),'a firm thunk in the right hand: '+JSON.stringify(s.pulses.slice(-3)));
    const st=s.physics.stuck('sword');
    assert.equal(st.onId,'dummy');assert.equal(st.material,'soft');assert.ok(st.depth===ev.depth&&st.hold===ev.hold&&st.tug===0);
    const saved=s.room.get('sword').data.physicsStuck;
    assert.ok(saved&&saved.on==='dummy'&&saved.a.length===3&&saved.b.length===3&&saved.q.length===4&&saved.dir.length===3&&saved.d===ev.depth&&saved.m==='soft','the record carries the saved stick: '+JSON.stringify(saved));
    assert.ok(saved.dir[2]<-.9,'the saved bite direction points into the straw (the dummy frame is unrotated)');
    assert.equal(s.physics.core.sticks.get('sword').joint.contactsEnabled?.()??false,false,'blade and straw no longer collide while it is in');
    // The joint pulls the blade in by its depth over a few steps; the hand hangs where the handle is.
    s.tick(60,{right:thrust()});
    const tip1=tipOf(s);
    assert.ok(tip1.z<FRONT-.03,`tip sunk into the straw: ${tip1.z.toFixed(3)} vs front ${FRONT}`);
    assert.ok(s.physics.stuck('sword')&&s.physics.stuck('sword').tug<st.hold*.2,'pushing it deeper is not a tug: '+s.physics.stuck('sword').tug.toFixed(0));
    assert.ok(s.physics.core.lean('dummy')>2*DEG,'the dummy leans back with the blade in it');
    // Pull the controller 0.35 m back: the hand stays on the handle, well off its controller, the blade stays in.
    let hung=null,freedAt=null;
    for(let i=0;i<270;i++){
      s.tick(1,{right:back()});
      const d=handPos(s).distanceTo(back().p);
      if(i===12){hung={d,stuck:!!s.physics.stuck('sword'),tip:tipOf(s)};}
      if(freedAt===null&&!s.physics.stuck('sword'))freedAt=i/90;
    }
    assert.ok(hung.stuck&&hung.d>.04&&hung.tip.z<FRONT,`a short pull leaves the hand hanging ${hung.d.toFixed(3)} m off its controller, blade still in`);
    assert.ok(freedAt!==null&&freedAt>.2&&freedAt<2,`a hard tug works it free after ${freedAt} s`);
    assert.equal(s.unsticks.length,1);
    const un=s.unsticks[0];
    assert.ok(un.id==='sword'&&un.onId==='dummy'&&un.why==='tug'&&un.tug>=un.hold&&un.hands[0]==='right',JSON.stringify(un));
    assert.ok(s.pulses.some(p=>p.hand==='right'&&p.intensity===.55&&p.time>=un.time-1e-6),'a shorter thunk when it gives');
    assert.equal(s.room.get('sword').data.physicsStuck,null,'the record says it is free');
    assert.equal(s.interact.held('right'),'sword','still in the hand');
    assert.ok(handPos(s).distanceTo(back().p)<.03,'the hand is back on its controller: '+handPos(s).distanceTo(back().p).toFixed(3));
    assert.ok(tipOf(s).z>FRONT-.03,'blade out of the straw');
    assert.equal(s.sticks.length,1,'resting against the straw afterwards does not stick it again');
  } finally { s.dispose(); }
});

test('what does not stick: a blunt wooden sword, the flat of the blade, a stone wall; wood takes a blade shallower than straw',()=>{
  const blunt=setup([record('bokken','wooden sword',[.04,1.1,0],{data:flat}),record('dummy','training dummy',[0,0,DUMMY_Z])]);
  try {
    arm(blunt,'bokken');
    blunt.tick(60,{right:thrust()});
    assert.ok(blunt.contacts.some(c=>c.materials.includes('soft')&&c.impulse>5),'it hits the straw hard');
    assert.equal(blunt.physics.stuck('bokken'),null,'and bounces: no edge');
    assert.equal(blunt.sticks.length,0);
  } finally { blunt.dispose(); }
  const slap=setup([record('sword','sword',[.04,1.1,0],{data:flat}),record('dummy','training dummy',[0,0,DUMMY_Z])]);
  try {
    arm(slap);
    slap.tick(90,{right:pose(.5,1.3,-.6)}); // blade alongside the dummy, tip past its front
    slap.tick(60,{right:pose(-.3,1.3,-.6)}); // sweep across: the flat of the blade slaps the straw
    assert.ok(slap.contacts.some(c=>c.materials.includes('soft')),'the flat slaps the straw');
    assert.equal(slap.physics.stuck('sword'),null,'the flat never sticks');
  } finally { slap.dispose(); }
  const stone=setup([record('sword','sword',[.04,1.1,0],{data:flat}),record('wall','stone wall',[0,0,-1.2],{data:wall('stone')})]);
  try {
    arm(stone,'sword',1.4);
    stone.tick(60,{right:pose(0,1.4,-1.0)});
    const c=stone.contacts.find(c=>c.materials.includes('stone'));
    assert.ok(c&&c.impulse>10,'a full thrust into stone');
    assert.equal(stone.physics.stuck('sword'),null,'stone does not take a blade');
  } finally { stone.dispose(); }
  const wood=setup([record('sword','sword',[.04,1.1,0],{data:flat}),record('wall','wood wall',[0,0,-1.2],{data:wall('wood')})]);
  try {
    arm(wood,'sword',1.4);
    wood.tick(60,{right:pose(0,1.4,-1.0)});
    const st=wood.physics.stuck('sword');
    assert.ok(st&&st.onId==='wall'&&st.material==='wood','the same thrust sticks in wood: '+JSON.stringify(st));
    assert.ok(st.depth<=.05&&st.depth>=.01&&st.hold<200,`shallower than straw, easier to free: ${st.depth.toFixed(3)} m, hold ${st.hold.toFixed(0)} N*s`);
    assert.ok(wood.physics.core.props.get('wall').fixed,'into a planted wall (a joint to a fixed body)');
  } finally { wood.dispose(); }
});

test('let go of a stuck sword and it stays in the dummy; grab it again and a tug frees it',()=>{
  const s=setup([record('sword','sword',[.04,1.1,0],{data:flat}),record('dummy','training dummy',[0,0,DUMMY_Z])]);
  try {
    arm(s);
    s.tick(60,{right:thrust()});
    assert.ok(s.physics.stuck('sword'),'stuck');
    assert.equal(s.interact.release('right'),'sword');
    // The hand was shoving it in; let go, the dummy rocks back with the blade in it and settles leaning a little under the sword's weight.
    s.tick(150,{});
    const before=vec(s.physics.entries.get('sword').body.translation());
    s.tick(180,{});
    const after=vec(s.physics.entries.get('sword').body.translation());
    assert.ok(s.physics.stuck('sword')&&after.distanceTo(before)<.03&&after.y>1,'still in the straw two seconds later: moved '+after.distanceTo(before).toFixed(3)+' m');
    assert.ok(s.physics.core.lean('dummy')>.5*DEG&&s.physics.core.lean('dummy')<10*DEG,'the dummy leans a little under the sword hanging in it: '+(s.physics.core.lean('dummy')/DEG).toFixed(1)+' deg');
    const r=s.room.get('sword');
    assert.ok(!r.attach&&r.data.physicsStuck?.on==='dummy'&&r.p[1]>1,'the record: not held, stuck, up in the air: '+JSON.stringify({attach:r.attach,p:r.p}));
    assert.equal(s.physics.canGrab('sword'),true,'a stuck weapon can be taken again');
    // Take the handle again and tug.
    const handle=vec(s.physics.entries.get('sword').body.translation()).add(new THREE.Vector3(0,.0,.05));
    const hand={p:handle,q:new THREE.Quaternion()};
    s.physics.setHands({right:hand});
    assert.equal(s.interact.grab('right',{point:hand.p,quat:hand.q}),'sword');
    s.tick(60,{right:hand});
    assert.ok(s.physics.stuck('sword'),'grabbing it does not free it');
    const away={p:handle.clone().add(new THREE.Vector3(0,0,.45)),q:new THREE.Quaternion()};
    let freedAt=null;
    for(let i=0;i<270&&freedAt===null;i++){s.tick(1,{right:away});if(!s.physics.stuck('sword'))freedAt=i/90;}
    assert.ok(freedAt!==null&&freedAt<2.5,'tugged free at '+freedAt+' s');
    assert.equal(s.unsticks.length,1);
    s.tick(60,{right:away});
    assert.ok(handPos(s).distanceTo(away.p)<.04&&s.interact.held('right')==='sword','and it came along in the hand');
    assert.equal(s.room.get('sword').data.physicsStuck,null);
  } finally { s.dispose(); }
});

test('a thrown axe sticks in a wooden wall bit first and hangs there; thrown flat it bounces off',()=>{
  const BIT=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),Math.PI/2); // bit (+X) toward -z
  for(const [name,q,shouldStick] of [['bit first',BIT,true],['flat on',new THREE.Quaternion(),false]]) {
    const s=setup([record('axe','axe',[0,1.4,-.5],{data:{physicsPose:[q.x,q.y,q.z,q.w]}}),record('wall','wood wall',[0,0,-1.2],{data:wall('wood')})]);
    try {
      const b=s.physics.entries.get('axe').body;
      assert.ok(b.mass()>1&&b.mass()<4,`an axe of ${b.mass().toFixed(2)} kg`);
      b.setLinvel({x:0,y:0,z:-6},true);
      s.tick(45,{});
      const c=s.contacts.find(c=>c.materials.includes('wood'));
      assert.ok(c&&c.impulse>5,name+': it hits the wall: '+c?.impulse.toFixed(1));
      const st=s.physics.stuck('axe');
      if(shouldStick) {
        assert.ok(st&&st.onId==='wall'&&st.material==='wood'&&st.depth>=.02,name+': stuck in the wood: '+JSON.stringify(st));
        assert.deepEqual(s.sticks[0].hands,[],'nobody was holding it');
        const p0=vec(b.translation());
        s.tick(180,{});
        const p1=vec(b.translation());
        assert.ok(s.physics.stuck('axe')&&p1.distanceTo(p0)<.02&&p1.y>1,`hangs in the wall: ${p1.toArray().map(v=>v.toFixed(2))}`);
      } else {
        assert.equal(st,null,name+': the flat of an axe head does not bite');
        s.tick(180,{});
        assert.ok(vec(b.translation()).y<.3,'it fell to the floor');
      }
    } finally { s.dispose(); }
  }
});

test('a sword stuck in the dummy rides its rocking; a reload of the room sets the same stick again with nothing written',()=>{
  const s=setup([record('sword','sword',[.04,1.1,0],{data:flat}),record('dummy','training dummy',[0,0,DUMMY_Z])]);
  let snapshot;
  try {
    arm(s);
    s.tick(60,{right:thrust()});
    assert.ok(s.physics.stuck('sword'));
    assert.equal(s.interact.release('right'),'sword');
    s.tick(240,{});
    const lean0=s.physics.core.lean('dummy'),tip0=tipOf(s);
    const sw=s.physics.entries.get('dummy').body;
    sw.applyImpulseAtPoint({x:0,y:0,z:-15},{x:0,y:1.6,z:DUMMY_Z+.2},true); // a knock on the head from the front
    let peak=0,tipAtPeak=null;
    for(let i=0;i<60;i++){s.tick(1,{});const l=s.physics.core.lean('dummy');if(l>peak){peak=l;tipAtPeak=tipOf(s);}}
    assert.ok(peak>lean0+4*DEG,`the dummy rocks with the sword in it: ${(peak/DEG).toFixed(1)} deg`);
    assert.ok(tipAtPeak.distanceTo(tip0)>.03,`the blade moves with the straw: ${tipAtPeak.distanceTo(tip0).toFixed(3)} m`);
    assert.ok(s.physics.stuck('sword'),'and stays in');
    s.tick(300,{});
    snapshot=JSON.parse(JSON.stringify(s.room.state));
    assert.ok(snapshot.objects.sword.data.physicsStuck?.on==='dummy'&&!snapshot.objects.sword.attach);
  } finally { s.dispose(); }
  const scene=new THREE.Scene(),room=new Room(),ops=[];
  const objects=new SceneObjects({scene,room,build});
  const physics=new PhysicsRoom({objects,room,send:op=>{ops.push(op);room.apply(op,{local:true});}});
  try {
    room.load(snapshot);
    for(let i=0;i<3;i++){objects.update(1/90,i/90);physics.setHands({});physics.update(1/90);}
    const st=physics.stuck('sword');
    assert.ok(st&&st.onId==='dummy'&&st.material==='soft'&&Math.abs(st.depth-snapshot.objects.sword.data.physicsStuck.d)<1e-9,'stuck again on load: '+JSON.stringify(st));
    assert.equal(ops.filter(o=>o.t==='set'&&o.id==='sword'&&o.patch.data&&'physicsStuck' in o.patch.data).length,0,'the record already said so: nothing written for it');
    // The dummy loads upright and leans again under the sword's weight (a few centimetres of blade travel), then holds.
    const saved=new THREE.Vector3().fromArray(snapshot.objects.sword.p);
    for(let i=0;i<180;i++){objects.update(1/90,i/90);physics.setHands({});physics.update(1/90);}
    const p0=vec(physics.entries.get('sword').body.translation());
    for(let i=0;i<180;i++){objects.update(1/90,i/90);physics.setHands({});physics.update(1/90);}
    const p1=vec(physics.entries.get('sword').body.translation());
    assert.ok(p1.distanceTo(p0)<.03&&p1.y>1&&p1.distanceTo(saved)<.15&&physics.stuck('sword'),`and it hangs where it was: settled ${p1.distanceTo(saved).toFixed(3)} m from the saved pose, then moved ${p1.distanceTo(p0).toFixed(3)}`);
  } finally { physics.dispose();objects.dispose(); }
});

// Two devices in one room (the harness of physics-ownership.test.mjs): each has its own Room, SceneObjects, Interact and
// PhysicsRoom; ops cross a relay that applies them locally at once and on the other side on its next tick.
function pair(records,{users=[{id:'u-a',online:true},{id:'u-b',online:true}]}={}) {
  const shared={users};
  let uid=0,seq=0;
  const sides={};
  const make=(me)=>{
    const scene=new THREE.Scene(),room=new Room(),queue=[];
    const objects=new SceneObjects({scene,room,build});
    const side={me,scene,room,objects,queue,sent:[]};
    side.send=op=>{op.uid=op.uid||('u'+(++uid));op.by=me;side.sent.push(op);room.apply(op,{local:true});for(const other of Object.values(sides))if(other!==side)other.queue.push(op);};
    side.physics=new PhysicsRoom({objects,room,send:side.send,getUser:()=>me,getUsers:()=>shared.users});
    side.interact=new Interact({objects,room,send:side.send,getUser:()=>me,metaOf:build.metaOfRecord});
    side.flush=()=>{for(const op of side.queue.splice(0))room.apply(op,{seq:++seq});};
    side.tick=(n,hands={})=>{for(let i=0;i<n;i++){side.flush();side.interact.update(1/90,hands);side.objects.update(1/90,i/90);side.physics.setHands(hands);side.physics.update(1/90);}};
    side.owner=id=>side.physics.ownership().find(o=>o.id===id);
    side.body=id=>side.physics.entries.get(id).body;
    return side;
  };
  sides.a=make('u-a');sides.b=make('u-b');
  const state={objects:Object.fromEntries(records.map(r=>[r.id,r])),order:records.map(r=>r.id),env:{time:'day'}};
  for(const s of Object.values(sides)){s.room.load(JSON.parse(JSON.stringify(state)));s.physics.sync();s.physics.refreshOwners();}
  const tick=(n,hands={})=>{for(let i=0;i<n;i++){sides.a.tick(1,hands.a??{});sides.b.tick(1,hands.b??{});}};
  return {a:sides.a,b:sides.b,shared,tick,dispose(){for(const s of Object.values(sides)){s.physics.dispose();s.objects.dispose();}}};
}

test('two devices: the striker\'s stick reaches the other device\'s record; its follower copy hangs in the dummy; when the striker leaves, the next host sets the same joint and the sword stays in',()=>{
  const s=pair([record('sword','sword',[.04,1.1,0],{data:flat}),record('dummy','training dummy',[0,0,DUMMY_Z])]);
  try {
    s.tick(120); // the sword falls and lands flat on the floor at the player's feet (a simulates it, b follows)
    // b (not the host) picks the sword up and thrusts it into the dummy; both the sword (held) and the dummy (near what b holds) become b's.
    const hand=pose(0,.06,0);
    s.tick(3,{b:{right:hand}});
    assert.equal(s.b.interact.grab('right',{point:hand.p,quat:hand.q}),'sword');
    s.tick(120,{b:{right:hand}});
    s.tick(90,{b:{right:pose(0,1.3,-.1)}});
    let stuckAt=null;
    for(let i=0;i<60&&stuckAt===null;i++){s.tick(1,{b:{right:thrust()}});if(s.b.physics.stuck('sword'))stuckAt=i;}
    assert.ok(stuckAt!==null,'stuck on b');
    s.tick(60,{b:{right:thrust()}});
    assert.equal(s.b.owner('sword').owner,'u-b');assert.equal(s.a.owner('sword').owner,'u-b','a agrees b holds it');
    assert.equal(s.a.owner('dummy').owner,'u-b','the dummy went to b when the sword came near');
    assert.ok(s.a.room.get('sword').data.physicsStuck?.on==='dummy','a\'s record carries the stick');
    assert.equal(s.a.physics.stuck('sword'),null,'a follows the stream, no joint of its own');
    assert.ok(s.a.body('sword').isKinematic()&&s.a.body('dummy').isKinematic());
    // b lets go: the sword hangs in the straw on both.
    assert.equal(s.b.interact.release('right'),'sword');
    s.tick(120,{});
    const pb=vec(s.b.body('sword').translation()),pa=vec(s.a.body('sword').translation());
    assert.ok(pb.y>1&&pa.distanceTo(pb)<.05,`a's copy hangs with b's: ${pa.distanceTo(pb).toFixed(3)} m apart`);
    assert.equal(s.a.physics.stuck('sword'),null);
    // b leaves: a is the host now, owns the sword and the dummy, and sets the saved stick again. Nothing falls.
    s.shared.users=[{id:'u-a',online:true}];
    s.a.tick(3);
    assert.equal(s.a.owner('sword').owner,'u-a');assert.equal(s.a.owner('dummy').owner,'u-a');
    assert.ok(s.a.body('sword').isDynamic()&&s.a.body('dummy').isDynamic(),'simulated on a');
    const st=s.a.physics.stuck('sword');
    assert.ok(st&&st.onId==='dummy'&&st.material==='soft','a set the joint from the record: '+JSON.stringify(st));
    assert.ok(s.a.physics.rig('dummy').mounted,'the dummy is on its post on a');
    // The dummy, followed upright until now, is simulated here from this moment and leans a little under the sword's weight; then it holds.
    const followed=vec(s.a.body('sword').translation());
    s.a.tick(180);
    const p0=vec(s.a.body('sword').translation());
    s.a.tick(180);
    const p1=vec(s.a.body('sword').translation());
    assert.ok(p1.distanceTo(p0)<.03&&p1.y>1&&p1.distanceTo(followed)<.15&&s.a.physics.stuck('sword'),`still in the dummy on a: settled ${p1.distanceTo(followed).toFixed(3)} m from the followed pose, then moved ${p1.distanceTo(p0).toFixed(3)} m`);
    assert.ok(s.a.physics.core.lean('dummy')<8*DEG,'the dummy stands with the sword in it: '+(s.a.physics.core.lean('dummy')/DEG).toFixed(1)+' deg');
  } finally { s.dispose(); }
});
