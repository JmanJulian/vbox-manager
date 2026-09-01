const log = (msg) => {
    const el = document.getElementById("output");
    if (el) el.innerText = msg;
};

let runningVMs = [], detectedStorageController = "SATA";

// 1. UNIVERSAL SHELL ROUTER: Dynamically finds your script across all user or system folders on any distro
function runApi(action, params = {}, cb = null) {
    const shellCmd = 'python3 $(dirname $(find /usr/share/cockpit/ ' +
                     '~/.local/share/cockpit/ -name vbox-backend.py 2>/dev/null | head -n 1))' +
                     '/vbox-backend.py "$@"';

    cockpit.spawn(["/bin/sh", "-c", shellCmd, "--", action, JSON.stringify(params)])
        .done(res => {
            try { 
                const data = JSON.parse(res); 
                if (data.error) log("⚠️ " + data.error); 
                else if (cb) cb(data); 
            } catch(e) { log("⚠️ Payload Parsing Error"); }
        })
        .fail(err => log("⚠️ System Failure: " + err.message));
}

// 2. GENERIC VALUE & UI VIEW MANIPULATORS
const getVal = id => document.getElementById(id)?.value?.trim() || "";
const getCheck = id => !!document.getElementById(id)?.checked;
const getSelectedVM = () => getVal("vm-list");

function switchTab(tabId) {
    document.querySelectorAll('.tab-link').forEach(el => el.classList.toggle('active', el.id === `tab-${tabId}-btn`));
    document.querySelectorAll('.tab-content').forEach(el => el.classList.toggle('active-content', el.id === `tab-${tabId}`));
    
    if (tabId === 'config') runApi("get_screenshot", { vm: getSelectedVM() }, d => document.getElementById("vbox-screen-canvas").src = d.src + "?v=" + new Date().getTime());
    if (tabId === 'media') runApi("scan_dir", { path: getVal("scan-dir-input") }, d => ['dir-picker-select', 'media-picker-select'].forEach(id => populateSelect(id, d.files, "-- Select an image file --")));
    if (tabId === 'advanced' && getSelectedVM()) runApi("advanced_info", { vm: getSelectedVM() }, d => {
        document.getElementById("adv-target-title").innerText = getSelectedVM();
        populateSelect("snap-picker-select", d.snapshots, "-- No checkpoints exist --");
        populateSelect("nat-picker-select", d.nat_rules.map(r => ({ val: r, txt: r.replace(/,/g, " | ") })), "-- No active NAT mappings --");
        populateSelect("sf-picker-select", d.shared_folders.map(f => ({ val: f.name, txt: `${f.name} ➔ ${f.path}` })), "-- No host shares mounted --");
    });
}

function populateSelect(id, items, fallback) {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = items.length ? "" : `<option value=''>${fallback}</option>`;
    items.forEach(i => el.innerHTML += `<option value="${i.val || i}">${i.txt || i}</option>`);
}

function updateSliders() {
    [
        { id: 'ram-amount', t: 'ram-val-display', u: ' MB' },
        { id: 'cpu-count', t: 'cpu-val-display', u: ' Cores' },
        { id: 'new-vm-ram', t: 'create-ram-val-display', u: ' MB' },
        { id: 'new-vm-cores', t: 'create-cpu-val-display', u: ' Cores' }
    ].forEach(s => {
        const el = document.getElementById(s.id);
        const target = document.getElementById(s.t);
        if (!el || !target) return;
        
        target.innerText = `${el.value}${s.u} / ${el.max}${s.u}`;
        el.style.setProperty('--safe-pct', `${((el.value - el.min) / (el.max - el.min)) * 100}%`);
    });
}
// 3. INVENTORY RENDERING CORE
function refreshVMs() {
    runApi("list_vms", { current: getSelectedVM() }, (data) => {
        const tbody = document.getElementById("vm-table-body");
        if (!tbody) return;
        tbody.innerHTML = data.vms.length ? "" : `<tr><td colspan="4" class="table-placeholder">No VMs registered.</td></tr>`;
        runningVMs = data.running;

        data.vms.forEach(vm => {
            const tr = document.createElement("tr");
            tr.id = `vm-row-${vm.name}`;
            if (vm.selected) {
                tr.className = "selected-table-row";
                detectedStorageController = vm.controller;
                ['ram-amount', 'cpu-count', 'gpu-driver', 'gpu-vram'].forEach(id => {
                    const f = document.getElementById(id);
                    if(f) { f.value = vm[id === 'ram-amount' ? 'ram' : id === 'cpu-count' ? 'cpu' : id === 'gpu-driver' ? 'gfx' : 'vram']; f.disabled = vm.running; }
                });
                document.getElementById("gpu-3d-accelerate").checked = (vm.accel === "on");
                document.getElementById("gpu-3d-accelerate").disabled = vm.running;
                updateSliders();
            }

            tr.onclick = (e) => {
                if (e.target.tagName !== "BUTTON") {
                    document.getElementById("vm-list").value = vm.name;
                    document.getElementById("config-target-title").innerText = vm.name;
                    refreshVMs();
                }
            };

            const btnHtml = vm.running 
                ? `<div class="flex-buttons" style="display:inline-flex; gap:4px; width:auto; margin:0!important;">
                    <button class="danger inline-dense-btn" data-action="stop" data-vm="${vm.name}">🛑 Stop</button>
                    <button class="danger inline-dense-btn" style="background-color:#930000!important;" data-action="kill" data-vm="${vm.name}">⚡ Kill</button>
                   </div>`
                : `<button class="success inline-dense-btn" data-action="start" data-vm="${vm.name}">▶️ Start</button>`;

            tr.innerHTML = `<td><strong>${vm.name}</strong></td>
                <td><span class="status-badge ${vm.running?'status-on':'status-off'}">${vm.running?'RUNNING':'POWER OFF'}</span></td>
                <td>${vm.cpu} Cores / ${vm.ram} MB</td><td>${btnHtml}</td>`;
            tbody.appendChild(tr);
        });
    });
}

// 4. THE GENERIC DECLARATIVE DISPATCH ROUTER
document.addEventListener("DOMContentLoaded", () => {
    const actions = {
        "tab-overview-btn": () => switchTab('overview'), "tab-config-btn": () => switchTab('config'),
        "tab-media-btn": () => switchTab('media'), "tab-advanced-btn": () => switchTab('advanced'),
        "refresh-btn": refreshVMs, "scan-dir-btn": () => switchTab('media'), "media-scan-dir-btn": () => switchTab('media'),
        "acc-trigger-snapshots": () => document.getElementById('acc-snapshots').classList.toggle("show-panel"),
        "acc-trigger-create-vm": () => document.getElementById('acc-create-vm').classList.toggle("show-panel"),
        "acc-trigger-nat": () => document.getElementById('acc-nat').classList.toggle("show-panel"),
        "acc-trigger-shared": () => document.getElementById('acc-shared').classList.toggle("show-panel"),
        
        "save-hw-btn": () => runApi("save_hw", { vm: getSelectedVM(), ram: getVal("ram-amount"), cpu: getVal("cpu-count"), gfx: getVal("gpu-driver"), vram: getVal("gpu-vram"), accel: getCheck("gpu-3d-accelerate") ? "on" : "off" }, refreshVMs),
        "create-vm-btn": () => runApi("create_vm", { name: getVal("new-vm-name"), ostype: getVal("new-vm-ostype"), ram: getVal("new-vm-ram"), cpu: getVal("new-vm-cores") }, refreshVMs),
        "delete-vm-btn": () => confirm(`Destroy ${getSelectedVM()}?`) && runApi("delete_vm", { vm: getSelectedVM(), files: getCheck("delete-files-check") }, refreshVMs),
        "attach-btn": () => runApi("attach_disk", { vm: getSelectedVM(), path: getVal("vdi-path"), ctrl: detectedStorageController }, refreshVMs),
        "detach-btn": () => runApi("detach_disk", { vm: getSelectedVM(), ctrl: detectedStorageController }, refreshVMs),
        "snap-take-btn": () => runApi("take_snap", { vm: getSelectedVM(), name: getVal("snap-name") }, () => switchTab('advanced')),
        "snap-restore-btn": () => runApi("restore_snap", { vm: getSelectedVM(), name: getVal("snap-picker-select") }, refreshVMs),
        "snap-delete-btn": () => confirm("Wipe snapshot?") && runApi("delete_snap", { vm: getSelectedVM(), name: getVal("snap-picker-select") }, () => switchTab('advanced')),
        "nat-add-btn": () => runApi("add_nat", { vm: getSelectedVM(), name: getVal("nat-rule-name"), proto: getVal("nat-proto"), hport: getVal("nat-host-port"), gport: getVal("nat-guest-port") }, () => switchTab('advanced')),
        "nat-del-btn": () => runApi("del_nat", { vm: getSelectedVM(), rule: getVal("nat-picker-select").split(',') }, () => switchTab('advanced')),
        "sf-add-btn": () => runApi("add_share", { vm: getSelectedVM(), name: getVal("sf-name"), path: getVal("sf-path"), auto: getCheck("sf-automount") }, () => switchTab('advanced')),
        "sf-del-btn": () => runApi("del_share", { vm: getSelectedVM(), name: getVal("sf-picker-select") }, () => switchTab('advanced'))
    };

    Object.entries(actions).forEach(([id, func]) => document.getElementById(id)?.addEventListener("click", func));

    const bindPicker = (sid, iid, rid) => document.getElementById(sid)?.addEventListener("change", (e) => document.getElementById(iid).value = (getVal(rid) + "/" + e.target.value).replace(/\/+/g, "/"));
    bindPicker("dir-picker-select", "vdi-path", "scan-dir-input");
    bindPicker("media-picker-select", "media-path", "media-scan-dir-input");

    document.getElementById("vm-table-body")?.addEventListener("click", (e) => {
        const act = e.target.getAttribute("data-action");
        const vm = e.target.getAttribute("data-vm");
        if (act && vm) runApi("power_action", { vm: vm, action: act }, () => setTimeout(refreshVMs, 1000));
    });

    ['ram-amount', 'cpu-count', 'new-vm-ram', 'new-vm-cores'].forEach(id => document.getElementById(id)?.addEventListener("input", updateSliders));

    // Dynamic Host Limit Collector
    runApi("host_limits", {}, d => {
        ['cpu-count','new-vm-cores'].forEach(id => { if(document.getElementById(id)) document.getElementById(id).max = d.cpu; });
        ['ram-amount','new-vm-ram'].forEach(id => { if(document.getElementById(id)) document.getElementById(id).max = d.ram; });
        
        updateSliders();
        
        populateSelect("new-vm-ostype", d.ostypes, "Failed to load profiles");
        if(document.getElementById("new-vm-ostype")) document.getElementById("new-vm-ostype").value = "Ubuntu_64";
        refreshVMs();
    });

    setInterval(() => getSelectedVM() && runApi("get_screenshot", { vm: getSelectedVM() }, d => d.src && (document.getElementById("vbox-screen-canvas").src = d.src + "?v=" + new Date().getTime())), 3000);
});
