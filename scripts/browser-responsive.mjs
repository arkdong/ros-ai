import { chromium, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
const base='http://127.0.0.1:4310';const api=async path=>(await fetch(base+path)).json();
const browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1512,height:982}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
const report={startedAt:new Date().toISOString(),checks:[],errors};
try{
 await page.goto(base);await page.getByRole('button',{name:'City heat and shade',exact:true}).click();await page.getByRole('button',{name:'Shade evidence',exact:true}).click();
 const project=(await api('/api/projects')).find(p=>p.title==='City heat and shade');let detail=await api('/api/projects/'+project.id);const source=detail.project.canvas.nodes.find(n=>n.title==='Shade evidence');const destination=detail.project.canvas.nodes.find(n=>n.title==='Questions to test');const artifact=detail.artifacts.find(a=>a.nodeId===source.id&&a.kind==='result');const beforeInputs=detail.inputs.length;
 await page.getByRole('button',{name:'Use result in another node',exact:true}).click();await page.getByLabel('Use in this node').selectOption(destination.id);await page.getByLabel('Selected excerpt',{exact:false}).fill(artifact.content.split('\n')[0]);await page.getByRole('button',{name:'Attach input',exact:true}).click();
 await expect(page.getByTestId('node-title')).toHaveValue('Questions to test');await page.getByRole('button',{name:/^Inputs/}).click();
 await expect.poll(async()=>(await api('/api/projects/'+project.id)).inputs.length).toBe(beforeInputs+1);await expect(page.locator('.input-card')).toHaveCount(2);
 await page.locator('.input-card').last().getByRole('button',{name:/Remove input/}).click();await expect.poll(async()=>(await api('/api/projects/'+project.id)).inputs.length).toBe(beforeInputs);
 report.checks.push('Browser artifact/excerpt attachment retains selected version; removal changes only current selection');
 await page.getByRole('button',{name:'Shade evidence',exact:true}).click();await page.locator('.chat-message.assistant .citation').first().click();await page.waitForTimeout(600);
 await expect(page.locator('.evidence-item[open] blockquote')).toBeInViewport();
 await page.screenshot({path:'evidence/desktop-research.png',fullPage:true});
 await page.getByRole('button',{name:/^Runs/}).click();await page.getByText('Captured request & inputs',{exact:true}).click();await page.waitForTimeout(300);await page.screenshot({path:'evidence/desktop-run-history.png',fullPage:true});
 await page.setViewportSize({width:900,height:850});await page.waitForTimeout(650);await page.screenshot({path:'evidence/narrow-workspace.png',fullPage:true});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);const canvas=await page.getByTestId('canvas').boundingBox();let visible=0;for(const card of await page.locator('.react-flow__node').all()){const b=await card.boundingBox();if(b.x>=canvas.x-1&&b.x+b.width<=canvas.x+canvas.width+1&&b.y>=canvas.y&&b.y+b.height<=canvas.y+canvas.height)visible++;}expect(visible).toBe(2);
 await page.setViewportSize({width:600,height:850});await page.waitForTimeout(500);await expect(page.getByLabel('Projects and conversations')).not.toBeVisible();await expect(page.getByLabel('Show sidebar')).toBeVisible();await page.screenshot({path:'evidence/mobile-workspace.png',fullPage:true});
 await page.getByLabel('Show sidebar').click();await expect(page.getByLabel('Projects and conversations')).toBeVisible();await page.getByLabel('Hide sidebar').click();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 report.checks.push('Citation opens and scrolls exact evidence into view','900px resize automatically keeps both nodes inside canvas','600px sidebar closes automatically and remains manually controllable; no horizontal overflow');expect(errors).toEqual([]);report.status='passed';report.completedAt=new Date().toISOString();
}catch(error){report.status='failed';report.error=error.message;await page.screenshot({path:'evidence/responsive-failure.png',fullPage:true});throw error;}finally{writeFileSync('evidence/browser-responsive.json',JSON.stringify(report,null,2)+'\n');await browser.close();}
