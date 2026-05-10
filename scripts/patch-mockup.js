'use strict'
const fs = require('fs')

let html = fs.readFileSync('C:/Users/scott/Code/aifactory/resources/mockup.html', 'utf8')
let changed = 0

function replace(from, to) {
  if (!html.includes(from)) { console.error('NOT FOUND:', from.slice(0, 80)); return }
  html = html.replace(from, to)
  changed++
}

// 1. Add polarisProjects to state
replace(
  'var ws=null,projects=[],currentProjectId=null,specQuestions=[],testQuestions=[],skillsList=[],routinesList=[],specIndex=0,testIndex=0,specEditMode=false,testEditMode=false;',
  'var ws=null,projects=[],currentProjectId=null,specQuestions=[],testQuestions=[],skillsList=[],routinesList=[],polarisProjects=[],specIndex=0,testIndex=0,specEditMode=false,testEditMode=false;'
)

// 2. Store polarisProjects on init
replace(
  "projects=msg.projects||[];specQuestions=msg.specQuestions||[];testQuestions=msg.testQuestions||[];skillsList=msg.skills||[];routinesList=msg.routines||[];if(msg.config)applyConfig(msg.config);renderAll();return}",
  "projects=msg.projects||[];specQuestions=msg.specQuestions||[];testQuestions=msg.testQuestions||[];skillsList=msg.skills||[];routinesList=msg.routines||[];polarisProjects=msg.polarisProjects||[];if(msg.config)applyConfig(msg.config);renderAll();return}"
)

// 3. Expand New Project modal with Polaris selector
replace(
  `<div class="modal-overlay" id="new-project-modal">
  <div class="modal" style="width:400px"><h2>New Project</h2>
    <div class="field"><label>Project Name</label><input id="new-project-name" type="text" placeholder="My Awesome App" onkeydown="if(event.key==='Enter')confirmNewProject()"></div>
    <div class="modal-footer"><button class="btn" onclick="closeModal('new-project-modal')">Cancel</button><button class="btn primary" onclick="confirmNewProject()">Create</button></div>
  </div>
</div>`,
  `<div class="modal-overlay" id="new-project-modal">
  <div class="modal" style="width:480px"><h2>New Project</h2>
    <div class="field"><label>Link to Polaris Project (sets working directory)</label>
      <select id="new-project-polaris" onchange="onPolarisProjectChange(this.value)" style="width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:8px 12px;border-radius:6px;font-size:13px">
        <option value="">&#8212; None / custom &#8212;</option>
      </select>
    </div>
    <div class="field"><label>Project Name</label><input id="new-project-name" type="text" placeholder="My Awesome App" onkeydown="if(event.key==='Enter')confirmNewProject()"></div>
    <div class="field"><label>Working Directory</label><input id="new-project-workdir" type="text" placeholder="Auto-filled from Polaris project, or enter a path"></div>
    <div class="modal-footer"><button class="btn" onclick="closeModal('new-project-modal')">Cancel</button><button class="btn primary" onclick="confirmNewProject()">Create</button></div>
  </div>
</div>`
)

// 4. Update showNewProjectModal to populate dropdown
replace(
  "function showNewProjectModal(){document.getElementById('new-project-name').value='';document.getElementById('new-project-modal').classList.add('open');setTimeout(function(){document.getElementById('new-project-name').focus()},50)}",
  [
    "function showNewProjectModal(){",
    "  var sel=document.getElementById('new-project-polaris');",
    "  sel.innerHTML='<option value=\"\">\\u2014 None / custom \\u2014</option>';",
    "  polarisProjects.forEach(function(p){var o=document.createElement('option');o.value=p.name;o.dataset.workdir=p.workDir;o.textContent=p.name+' — '+p.workDir;sel.appendChild(o)});",
    "  document.getElementById('new-project-name').value='';",
    "  document.getElementById('new-project-workdir').value='';",
    "  document.getElementById('new-project-modal').classList.add('open');",
    "  setTimeout(function(){document.getElementById('new-project-name').focus()},50)}"
  ].join('')
)

// 5. Update confirmNewProject
replace(
  "function confirmNewProject(){var name=document.getElementById('new-project-name').value.trim();if(!name)return;send({type:'create-project',name:name});closeModal('new-project-modal')}",
  [
    "function confirmNewProject(){",
    "  var name=document.getElementById('new-project-name').value.trim();if(!name)return;",
    "  var workDir=document.getElementById('new-project-workdir').value.trim()||null;",
    "  var polarisProjectName=document.getElementById('new-project-polaris').value||null;",
    "  send({type:'create-project',name:name,workDir:workDir,polarisProjectName:polarisProjectName});",
    "  closeModal('new-project-modal')}"
  ].join('')
)

// 6. Add onPolarisProjectChange before editSpec export
replace(
  "window.editSpec=function(){specEditMode=true;specIndex=0;renderSpecPanel(currentProject())};",
  [
    "window.onPolarisProjectChange=function(name){",
    "  var p=polarisProjects.find(function(x){return x.name===name});",
    "  if(p){document.getElementById('new-project-workdir').value=p.workDir;",
    "    if(!document.getElementById('new-project-name').value)document.getElementById('new-project-name').value=p.name}",
    "  else{document.getElementById('new-project-workdir').value=''}",
    "};",
    "window.editSpec=function(){specEditMode=true;specIndex=0;renderSpecPanel(currentProject())};"
  ].join('')
)

fs.writeFileSync('C:/Users/scott/Code/aifactory/resources/mockup.html', html, 'utf8')
console.log('Patches applied:', changed, '| Size:', fs.statSync('C:/Users/scott/Code/aifactory/resources/mockup.html').size, 'bytes')
