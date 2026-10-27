import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KidLibrary } from "../bridge/kid-library.mjs";
import { resolveCharacter } from "../js/parts/character-spawn.js";
import { normalizeBlueprint } from "../js/core/blueprint.js";

function blueprint(name) {
  return { name, aliases: [], category:"aquatic", holdable:false,
    parts:[{shape:"sphere",p:[0,.55,0],s:[.8,.8,1],color:"#427c9b",mat:"matte"}] };
}
test("kid library only loads hit batch; spoken phrases and aliases resolve; absent names do not", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),"kid-library-"));
  t.after(() => fs.rm(dir,{recursive:true,force:true}));
  const libdir=path.join(dir,"kid-library");
  await fs.mkdir(libdir);
  await fs.writeFile(path.join(libdir,"batch-0000.json"),JSON.stringify({blueprints:[blueprint("axolotl"),blueprint("pistol shrimp")]}));
  await fs.writeFile(path.join(libdir,"batch-0001.json"),JSON.stringify({blueprints:[blueprint("giant isopod")]}));
  const ix={entries:[
    {name:"axolotl",aliases:["mexican walking fish"],group:"aquatic",file:"batch-0000.json",slot:0},
    {name:"pistol shrimp",aliases:["snapping shrimp"],group:"aquatic",file:"batch-0000.json",slot:1},
    {name:"giant isopod",aliases:[],group:"aquatic",file:"batch-0001.json",slot:0}
  ]};
  await fs.writeFile(path.join(libdir,"index.json"),JSON.stringify(ix));
  const library=new KidLibrary(dir);
  assert.equal((await library.resolve("spawn an axolotl beside me")).name,"axolotl");
  assert.equal((await library.resolve("make me a snapping shrimp")).name,"pistol shrimp");
  assert.equal(library.cache.size,1);
  assert.equal((await library.resolve("generate a giant isopod with freckles")).name,"giant isopod");
  assert.equal(library.cache.size,2);
  assert.equal(await library.resolve("spawn something made up"),null);
  assert.equal(library.count,3);
  const net={connected:true,character:cmd=>library.resolve(cmd)};
  const result=await resolveCharacter(net,"generate a giant isopod");
  assert.equal(result.name,"giant isopod");
  assert.equal(normalizeBlueprint(result.blueprint).ok,true);
});
test("kid library rejects traversal in malicious index", async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"kid-library-path-"));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.mkdir(path.join(dir,"kid-library"));
  await fs.writeFile(path.join(dir,"kid-library","index.json"),JSON.stringify({entries:[
    {name:"not-safe",group:"aquatic",file:"../../something.json",slot:0}
  ]}));
  const lib=new KidLibrary(dir);
  assert.equal(await lib.resolve("make not-safe"),null);
});
