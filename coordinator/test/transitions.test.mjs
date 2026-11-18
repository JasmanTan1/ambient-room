import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clean, queueInsert, orderWaiting, validate, api } from '../src/common.mjs';
const cases=JSON.parse(readFileSync(new URL('../contract/fixtures/transition-cases.json',import.meta.url)));
for(const c of cases.filter(x=>['message','queue_insert','party_order'].includes(x.domain))){
 test(`P0 transition: ${c.name}`,()=>{
  if(c.domain==='message')assert.equal(clean(c.input.raw),c.expected.text);
  if(c.domain==='queue_insert')assert.deepEqual(queueInsert(c.input.queue,c.input.track,c.input.current,c.input.where),c.expected.queue);
  if(c.domain==='party_order')assert.deepEqual(orderWaiting(c.input.waiting.map(x=>({...x,sequence:x.id})),c.input.order,c.input.lastTurn).map(x=>x.id),c.expected.ids);
 });
}
const schemaCases=JSON.parse(readFileSync(new URL('../contract/fixtures/schema-cases.json',import.meta.url)));
for(const c of schemaCases){test(`P0 schema: ${c.name}`,()=>{assert.equal(validate(api.components.schemas[c.schema],c.value),c.valid);});}
