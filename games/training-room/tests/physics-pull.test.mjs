// Codex (Command). Real input/room/physics path; no substitute physics solver.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.min.js';
import { Room } from '../js/room.js';
import { SceneObjects } from '../js/world/objects.js';
import * as build from '../js/parts/build/index.js';
import { Interact } from '../js/play/interact.js';
import { PhysicsRoom, initPhysics } from '../js/physics/sync.js';
await initPhysics();
build.setPhysicsColliders(true);
const pose=(x=0,y=1.1,z=0)=>({p:new THREE.Vector3(x,y,z),q:new THREE.Quaternion()});
function setup({wall=false}={}) {
  const scene=new THREE.Scene(),room=new Room(),ops=[];
  const objects=new SceneObjects({scene,room,build});
  const send=op=>{ops.push(op);room.apply(op,{local:true});};
  const physics=new PhysicsRoom({objects,room,send,scene});
  const records=[{id:'ball',part:'ball',p:[3,1,0],ry:0,s:1}];
  if(wall)records.push({id:'wall',part:'pull barrier',p:[1.5,0,0],ry:0,s:1,data:{blueprint:{name:'pull barrier',size:[.05,4,4],parts:[{shape:'box',p:[0,2,0],s:[.05,4,4],mat:'stone',color:'#888888'}]}}});
  room.load({objects:Object.fromEntries(records.map(r=>[r.id,r])),order:records.map(r=>r.id),env:{time:'day'}});
  physics.sync();
  scene.updateMatrixWorld(true); // The browser renderer updates mesh matrices before input.
  const interact=new Interact({objects,room,send,getUser:()=> 'local',metaOf:build.metaOfRecord});
  let hand=pose();
  const tick=n=>{for(let i=0;i<n;i++){interact.update(1/90,{right:hand});objects.update(1/90,i/90);physics.setHands({right:hand});physics.update(1/90);scene.updateMatrixWorld(true);}};
  const grab=()=>interact.grab('right',{point:hand.p,quat:hand.q,raycaster:new THREE.Raycaster(hand.p,new THREE.Vector3(1,0,0))});
  const body=physics.entries.get('ball').body;
  return {physics,interact,room,objects,ops,body,tick,grab,setHand:p=>{hand=p;},dispose(){physics.dispose();objects.dispose();}};
}
test('distance squeeze pulls the real ball continuously, then attaches a dynamic joint at the palm',()=>{
  const s=setup();
  try {
    const start={...s.body.translation()};
    assert.equal(s.grab(),'ball');
    const h=s.physics.core.hands.get('right');
    assert.equal(h.joint,null,'no remote joint that snaps an object across the room');
    assert.deepEqual({...s.body.translation()},start,'input never teleports the object');
    s.tick(1);
    assert.ok(s.body.translation().x<start.x && s.body.translation().x>2.8,'pull starts with finite acceleration');
    s.tick(270);
    assert.ok(h.joint,'pull attaches only on arrival');
    assert.ok(s.body.translation().x<.5,'ball actually arrived');
    assert.ok(s.body.isDynamic());
    assert.equal(s.interact.held('right'),'ball');
    assert.ok(!s.objects.entries.get('ball').fly);
  }finally{s.dispose();}
});
test('release during flight cancels the pull, preserves velocity and permits another grab',()=>{
  const s=setup();
  try {
    assert.equal(s.grab(),'ball');s.tick(10);
    const before={...s.body.linvel()};
    assert.equal(s.interact.release('right'),'ball');
    assert.deepEqual({...s.body.linvel()},before);
    assert.equal(s.physics.core.hands.get('right').id,null);
    assert.equal(s.room.get('ball').attach,undefined);
    assert.equal(s.grab(),'ball','reservation is released immediately');
  }finally{s.dispose();}
});
test('a wall blocks selection; an obstruction added after selection stops the pulled ball',()=>{
  const blocked=setup({wall:true});
  try{assert.equal(blocked.grab(),null,'cannot select through scenery');}finally{blocked.dispose();}
  const s=setup();
  try {
    assert.equal(s.grab(),'ball');
    s.physics.core.add('obstruction',{p:{x:1.5,y:2,z:0},fixed:true,shapes:[{p:{x:0,y:0,z:0},size:{x:.05,y:4,z:4},material:'stone'}]});
    s.tick(270);
    assert.ok(s.body.translation().x>1.5,'CCD collisions resist the pull');
    assert.equal(s.physics.core.hands.get('right').joint,null,'no joint across the obstruction');
    s.tick(540);
    assert.equal(s.interact.held('right'),null,'a blocked pull times out and clears the record');
  }finally{s.dispose();}
});
test('tracking loss during pull and hold drops the reservation, recovery requires a fresh squeeze',()=>{
  for(const held of [false,true]) {
    const s=setup();
    try {
      assert.equal(s.grab(),'ball');if(held)s.tick(270);
      s.setHand(null);s.tick(1);
      assert.equal(s.physics.core.hands.has('right'),false);
      assert.equal(s.interact.held('right'),null);
      assert.equal(s.room.get('ball').attach,undefined);
      s.setHand(pose());s.tick(1);
      assert.equal(s.physics.core.hands.get('right').joint,null);
      assert.equal(s.physics.core.hands.get('right').id,null,'no stale automatic regrab');
    }finally{s.dispose();}
  }
});
test('delete during a pull removes the reservation and leaves the recovered hand usable',()=>{
  const s=setup();
  try {
    assert.equal(s.grab(),'ball');s.room.apply({t:'del',ids:['ball']},{local:true});s.tick(1);
    assert.equal(s.physics.core.hands.get('right').id,null);
    assert.equal(s.interact.held('right'),null);
    assert.equal(s.physics.entries.has('ball'),false);
  }finally{s.dispose();}
});
