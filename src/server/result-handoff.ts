import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import { Store, StoreError } from './store.js';

/** Explicit version selection only: never enqueue work or infer from a wire. */
export function attachResultHandoffRoutes(app:Express,store:Store) {
  app.post('/api/projects/:id/artifacts/:artifactId/handoff',(req,res)=>{
    const body=z.object({nodeId:z.string().min(1).max(128),hash:z.string().regex(/^[a-f0-9]{64}$/),expectedRevision:z.number().int().nonnegative()}).strict().parse(req.body);
    const projectId=String(req.params.id),artifact=store.getArtifact(String(req.params.artifactId));
    if(artifact.projectId!==projectId||artifact.hash!==body.hash)throw new StoreError('Choose an exact output from this project.',409);
    const receipt=store.atomic(()=>{
      const project=store.getProject(projectId),node=project.canvas.nodes.find(value=>value.id===body.nodeId);
      if(!node||node.kind==='group')throw new StoreError('Choose a research block in this project.');
      if(project.revision!==body.expectedRevision)throw new StoreError('The workspace changed. Review this handoff again.',409);
      const isCsv=['dataset','table'].includes(artifact.kind)&&artifact.mediaType==='text/csv';
      const executable=node.blockType==='code'&&isCsv;
      if(executable)store.mutate(projectId,[{type:'updateNode',id:node.id,patch:{code:{language:node.code?.language??'python',source:node.code?.source??'',parameters:node.code?.parameters??{},inputArtifactId:artifact.id}}}],`Select exact CSV for ${node.title}`,project.revision);
      const selection=store.addInput(projectId,node.id,artifact.id);
      const record={id:randomUUID(),at:new Date().toISOString(),projectId,sourceNodeId:artifact.nodeId,artifactId:artifact.id,hash:artifact.hash,destinationNodeId:node.id,selectionId:selection.id,mode:executable?'single-csv-input':'selected-evidence',executionStarted:false};
      store.saveRecord('result-handoff',record.id,projectId,record);
      return record;
    });
    res.status(201).json(receipt);
  });
}
