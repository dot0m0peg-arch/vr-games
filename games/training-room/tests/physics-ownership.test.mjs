// P4 ownership: several devices in one room, one simulating owner per physics body (js/physics/ownership.js, applied in
// js/physics/sync.js). The rule is pure over the shared room state, so two devices with the same records and users list
// name the same owner for every body without extra messages; the non-owner runs a kinematic follower of the owner's
// 15 Hz pose stream. A hand that comes near, hits or takes hold of another device's body claims it (the newest claim wins
// everywhere, ties by user id). Owner, Oct 25 2026 (Claude Duet transmitter): "they're not integrating the way that I
// need them to just stickulate." Claude (Command), Oct 26 2026.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.min.js';
import { Room } from '../js/room.js';
import { SceneObjects } from '../js/world/objects.js';
import * as build from '../js/parts/build/index.js';
import { Interact } from '../js/play/interact.js';
import { PhysicsRoom, initPhysics } from '../js/physics/sync.js';
import { presentUsers, hostOf, ownerOf, newerClaim, claimOf, claimsOther, CLAIM_REACH } from '../js/physics/ownership.js';
await initPhysics();
build.setPhysicsColliders(true);
const DEG=Math.PI/180;
const record=(id,part,p,extra={})=>({id,part,p,ry:0,s:1,label:part,...extra});
const pose=(x,y,z)=>({p:new THREE.Vector3(x,y,z),q:new THREE.Quaternion()});
const vec=o=>new THREE.Vector3(o.x,o.y,o.z);

// Two devices in one room: each has its own Room, SceneObjects, Interact and PhysicsRoom. Ops cross a relay that
// applies them locally at once and to the other side on its next tick, in one order, as the laptop bridge does.
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
  const agree=id=>{const oa=sides.a.owner(id),ob=sides.b.owner(id);assert.ok(oa&&ob,'both sides know '+id);assert.equal(oa.owner,ob.owner,`both sides name the same owner for ${id}: ${oa.owner} vs ${ob.owner}`);return oa.owner;};
  return {a:sides.a,b:sides.b,shared,tick,agree,dispose(){for(const s of Object.values(sides)){s.physics.dispose();s.objects.dispose();}}};
}

test('the rule: host is the smallest present id, a holder owns what it holds, the newest claim wins (ties by id), onto follows its base, standalone is ours',()=>{
  const users=[{id:'u-b',online:true},{id:'u-a',online:false},{id:'',online:true},{id:7}];
  const present=presentUsers(users,'u-c');
  assert.deepEqual([...present].sort(),['u-a','u-b','u-c'],'everyone the bridge lists is present (its online flag is stale between broadcasts); we always are');
  assert.equal(hostOf(present),'u-a');
  const state={objects:{}};
  const own=r=>ownerOf(r,{state,present,me:'u-c'});
  assert.equal(own({id:'x',p:[0,0,0]}),'u-a','a free body belongs to the host');
  assert.equal(own({id:'x',p:[0,0,0],attach:{user:'u-b',hand:'right'}}),'u-b','a held body belongs to the holder');
  assert.equal(own({id:'x',p:[0,0,0],attach:{user:'u-z',hand:'right'}}),'u-a','a holder who left does not count');
  assert.equal(own({id:'x',p:[0,0,0],data:{physicsClaim:{user:'u-c',n:3}}}),'u-c','a claim beats the host');
  assert.equal(own({id:'x',p:[0,0,0],data:{physicsClaim:{user:'u-c',n:3}},attach:{user:'u-b',hand:'left'}}),'u-b','holding beats a claim');
  assert.equal(own({id:'x',p:[0,0,0],data:{physicsClaim:{user:'u-z',n:9}}}),'u-a','a claim by someone gone falls back to the host');
  assert.deepEqual(newerClaim({user:'u-a',n:2},{user:'u-b',n:3}),{user:'u-b',n:3});
  assert.deepEqual(newerClaim({user:'u-b',n:3},{user:'u-a',n:3}),{user:'u-a',n:3},'equal n: the smaller id');
  assert.deepEqual(newerClaim(null,{user:'u-b',n:0}),{user:'u-b',n:0});
  assert.equal(newerClaim({user:'u-b',n:'x'},{user:'',n:1}),null,'broken claims are ignored');
  const ledger=new Map([['x',{user:'u-b',n:5}]]);
  assert.deepEqual(claimOf({id:'x',data:{physicsClaim:{user:'u-c',n:4}}},ledger),{user:'u-b',n:5},'a stale claim written back into the record cannot undo a newer one seen');
  state.objects.tray={id:'tray',p:[0,0,0],attach:{user:'u-b',hand:'left'}};
  assert.equal(own({id:'cup',p:[0,0,0],onto:'tray'}),'u-b','a cup on a held tray rides with the holder');
  state.objects.loop1={id:'loop1',p:[0,0,0],onto:'loop2'};state.objects.loop2={id:'loop2',p:[0,0,0],onto:'loop1'};
  assert.equal(own(state.objects.loop1),'u-a','an onto loop ends at the host');
  assert.equal(ownerOf({id:'x',p:[0,0,0]},{state,present:presentUsers([],'local'),me:'local'}),'local','standalone: everything is ours');
  assert.equal(claimsOther('u-a','u-b'),true);assert.equal(claimsOther('u-b','u-a'),false);assert.equal(claimsOther('u-b','u-a',{hand:true}),true,'a hand always claims');
});

test('two devices agree: the host simulates a free crate and the other follows its fall; only the owner streams',()=>{
  const s=pair([record('crate','crate',[0,1.5,0])]);
  try {
    assert.equal(s.agree('crate'),'u-a','the smaller user id hosts');
    assert.ok(s.a.body('crate').isDynamic()&&!s.a.owner('crate').kinematic,'simulated on a');
    assert.ok(s.b.body('crate').isKinematic()&&s.b.owner('crate').kinematic,'followed on b');
    s.tick(240);
    const ba=s.a.objects.bounds('crate'),bb=s.b.objects.bounds('crate');
    assert.ok(Math.abs(ba.min.y)<.02,`a's crate landed: ${ba.min.y.toFixed(3)}`);
    assert.ok(Math.abs(bb.min.y)<.05,`b's crate followed it down: ${bb.min.y.toFixed(3)}`);
    assert.ok(vec(s.a.body('crate').translation()).distanceTo(vec(s.b.body('crate').translation()))<.03,'the two copies sit together');
    const streams=s.a.sent.filter(op=>op.t==='set'&&op.id==='crate'&&op.patch.p);
    assert.ok(streams.length>=5&&streams.some(op=>op.transient)&&streams.at(-1).transient!==true,'a streamed poses while it moved and a final resting one');
    assert.equal(s.b.sent.filter(op=>op.t==='set'&&op.patch.p).length,0,'the follower never writes a pose');
    assert.equal(s.agree('crate'),'u-a');
  }finally{s.dispose();}
});

test('a hand near (or a swing into) another device\'s body claims it: both sides agree, the body swaps sides, a later claim wins again',()=>{
  const s=pair([record('crate','crate',[0,.4,-1]),record('far','crate',[3,.4,3])]);
  try {
    s.tick(30);
    assert.equal(s.agree('crate'),'u-a');
    // b's right hand comes within reach of the crate (its box is 0.8 m wide: the hand sits 0.1 m off its face).
    const near=pose(0,.4,-1+.4+CLAIM_REACH-.15);
    s.tick(6,{b:{right:near}});
    assert.equal(s.agree('crate'),'u-b','b claimed what its hand came near');
    assert.ok(s.b.body('crate').isDynamic()&&s.a.body('crate').isKinematic(),'now simulated on b, followed on a');
    assert.equal(s.agree('far'),'u-a','the far crate stays with the host');
    const claim=s.a.owner('crate').claim;
    assert.deepEqual(claim,{user:'u-b',n:1},'the claim travelled in a data patch: '+JSON.stringify(claim));
    assert.ok(s.b.room.get('crate').data.physicsClaim.user==='u-b','and is in the record on b');
    // b walks away; a swings its hand into the crate: the contact claims it back (n = 2), b follows again.
    s.tick(60);
    s.tick(60,{a:{right:pose(0,.5,-2.2)}});
    let hit=false;
    for(let i=0;i<60&&!hit;i++){s.tick(1,{a:{right:pose(0,.5,-2.2+i*.03)}});hit=s.a.owner('crate').owner==='u-a';}
    assert.ok(hit,'a\'s hand on the crate claimed it');
    s.tick(10);
    assert.equal(s.agree('crate'),'u-a');
    assert.deepEqual(s.b.owner('crate').claim,{user:'u-a',n:2});
    assert.ok(s.a.body('crate').isDynamic()&&s.b.body('crate').isKinematic());
  }finally{s.dispose();}
});

test('taking hold of another device\'s body makes it ours at once; the attach seals it; the follower rides the stream; release keeps the claim',()=>{
  const s=pair([record('sword','sword',[0,.03,-1],{data:{physicsPose:[0,0,-Math.SQRT1_2,Math.SQRT1_2]}})]);
  try {
    s.tick(30);
    assert.equal(s.agree('sword'),'u-a');
    // b reaches down and grabs the sword through the real Interact path.
    const hand=pose(0,.05,-1);
    s.tick(3,{b:{right:hand}});
    assert.equal(s.b.interact.grab('right',{point:hand.p,quat:hand.q}),'sword','b takes the sword');
    assert.equal(s.b.owner('sword').owner,'u-b','ours the moment the hand closes');
    assert.ok(s.b.body('sword').isDynamic()&&s.b.physics.holds('right','sword'),'held by a joint on b');
    s.tick(3,{b:{right:hand}});
    assert.equal(s.agree('sword'),'u-b');
    assert.equal(s.a.room.get('sword').attach?.user,'u-b','a sees b holding it');
    assert.ok(s.a.body('sword').isKinematic(),'a follows it');
    assert.equal(s.a.interact.grab('right',{point:hand.p,quat:hand.q}),null,'a cannot take what b holds');
    // b lifts and carries it; a's copy comes along.
    const up=pose(.6,1.4,-1.6);
    s.tick(120,{b:{right:up}});
    const pb=vec(s.b.body('sword').translation()),pa=vec(s.a.body('sword').translation());
    assert.ok(pb.y>1&&pb.distanceTo(up.p)<.2,'b carries it: '+pb.toArray().map(v=>v.toFixed(2)));
    assert.ok(pa.distanceTo(pb)<.08,`a's copy follows within 8 cm: ${pa.distanceTo(pb).toFixed(3)} m`);
    // b lets go: the sword falls on b and the claim stays with b, so a keeps following.
    assert.equal(s.b.interact.release('right'),'sword');
    s.tick(120,{b:{right:up}});
    assert.equal(s.agree('sword'),'u-b','the claim outlives the hold');
    assert.ok(!s.a.room.get('sword').attach&&vec(s.b.body('sword').translation()).y<.3,'dropped and landed on b');
    assert.ok(vec(s.a.body('sword').translation()).distanceTo(vec(s.b.body('sword').translation()))<.05,'a\'s copy landed with it');
  }finally{s.dispose();}
});

test('a rig: the owner\'s swing streams, the follower leans with it and never springs or breaks on its own; a tear-off is told to the room',()=>{
  const s=pair([record('dummy','training dummy',[0,0,-1.5])]);
  try {
    s.tick(30);
    assert.equal(s.agree('dummy'),'u-a');
    assert.ok(s.a.physics.rig('dummy').mounted&&s.b.physics.rig('dummy').mounted,'mounted on both');
    assert.ok(s.b.body('dummy').isKinematic()&&s.a.body('dummy').isDynamic());
    // A knock on a's swing: it rocks there; b's copy, driven only by the stream, leans too.
    s.a.body('dummy').applyImpulse({x:0,y:0,z:-25},true);
    let peakA=0,peakB=0;
    for(let i=0;i<90;i++){s.tick(1);peakA=Math.max(peakA,s.a.physics.core.lean('dummy'));peakB=Math.max(peakB,s.b.physics.core.lean('dummy'));}
    assert.ok(peakA>8*DEG,`knocked back on a: ${(peakA/DEG).toFixed(1)} deg`);
    assert.ok(peakB>5*DEG&&Math.abs(peakB-peakA)<6*DEG,`b leaned with it: ${(peakB/DEG).toFixed(1)} vs ${(peakA/DEG).toFixed(1)} deg`);
    assert.ok(s.a.sent.some(op=>op.t==='set'&&op.id==='dummy'&&op.patch.data?.physicsSwing&&op.transient),'the swing pose streamed');
    assert.equal(s.b.sent.filter(op=>op.id==='dummy').length,0,'the follower wrote nothing');
    s.tick(400);
    assert.ok(s.a.physics.core.lean('dummy')<1.5*DEG&&s.b.physics.core.lean('dummy')<3*DEG,'both settled upright');
    // A brutal hit tears it off on a: the record says so and b lets go of its mount too.
    s.a.body('dummy').applyImpulse({x:0,y:0,z:-120},true);
    s.tick(120);
    assert.equal(s.a.physics.rig('dummy').mounted,false,'torn off on a');
    assert.equal(s.a.room.get('dummy').data?.physicsBroken,true,'the room was told');
    assert.equal(s.b.physics.rig('dummy').mounted,false,'b let go of it too');
    assert.ok(vec(s.b.body('dummy').translation()).y<1.2,'b\'s top came down with the stream: y '+vec(s.b.body('dummy').translation()).y.toFixed(2));
    assert.equal(s.agree('dummy'),'u-a');
  }finally{s.dispose();}
});

test('the owner leaves: the next host takes over where the follower had it, moving at the followed speed',()=>{
  const s=pair([record('crate','crate',[0,3,0])]);
  try {
    s.tick(20); // falling, a simulating, b following
    assert.equal(s.agree('crate'),'u-a');
    const before=vec(s.b.body('crate').translation());
    assert.ok(before.y<3&&before.y>1,'mid-fall on b: '+before.y.toFixed(2));
    s.shared.users=[{id:'u-b',online:true}];
    s.b.tick(1);
    assert.equal(s.b.owner('crate').owner,'u-b','b is the host now');
    assert.ok(s.b.body('crate').isDynamic(),'simulated on b');
    const v=s.b.body('crate').linvel();
    assert.ok(v.y<-1,'it kept falling at the followed speed: '+v.y.toFixed(2));
    s.b.tick(240);
    assert.ok(Math.abs(s.b.objects.bounds('crate').min.y)<.02,'and landed on b');
  }finally{s.dispose();}
});

test('claims that cross on the wire end the same on both sides',()=>{
  // A third device (u-0) hosts, so neither a nor b owns the crate; then both claim it in the same instant.
  const s=pair([record('crate','crate',[0,.4,0])],{users:[{id:'u-0',online:true},{id:'u-a',online:true},{id:'u-b',online:true}]});
  try {
    s.tick(10);
    assert.equal(s.agree('crate'),'u-0','the host is a device that is not here');
    assert.ok(s.a.body('crate').isKinematic()&&s.b.body('crate').isKinematic(),'both follow');
    s.a.physics.claim('crate',{force:true});s.b.physics.claim('crate',{force:true});
    assert.equal(s.a.owner('crate').owner,'u-a','each believes it owns the crate until the other claim arrives');assert.equal(s.b.owner('crate').owner,'u-b');
    s.tick(2);
    const owner=s.agree('crate');
    assert.equal(owner,'u-a','equal claims: the smaller id, on both sides');
    assert.ok(s.a.body('crate').isDynamic()&&s.b.body('crate').isKinematic(),'simulated on a, followed on b');
    assert.deepEqual(s.b.owner('crate').claim,{user:'u-a',n:1});
    // b claims again later: a newer claim, so it wins on both sides.
    s.tick(60);
    s.b.physics.claim('crate',{force:true});
    s.tick(2);
    assert.equal(s.agree('crate'),'u-b');
    assert.deepEqual(s.a.owner('crate').claim,{user:'u-b',n:2});
  }finally{s.dispose();}
});
