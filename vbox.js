const log = (msg) => {
    const el = document.getElementById("output");
    if (el) el.innerText = msg;
};
let runningVMs = [], detectedStorageController = "SATA", screenLoopInterval = null;

let VBOX_ENV = { "HOME": "/home", "USER": "" };
let SCR_PATH = "";

function resolveHostIdentity(callback) {
    cockpit.spawn(["whoami"])
        .done(username => {
            const user = username.trim();
            VBOX_ENV.USER = user;
            VBOX_ENV.HOME = user === 'root' ? '/root' : `/home/${user}`;
            SCR_PATH = `${VBOX_ENV.HOME}/.local/share/cockpit/vbox-manager/scr-cache.png`;
            log(`Session authenticated under server user: ${user}`);
            if (callback && typeof callback === "function") callback();
        })
        .fail(() => {
            VBOX_ENV.USER = "root";
            VBOX_ENV.HOME = "/root";
            SCR_PATH = "/root/.local/share/cockpit/vbox-manager/scr-cache.png";
            if (callback && typeof callback === "function") callback();
        });
}

function _call(args, cb) {
    cockpit.spawn(args, { env: VBOX_ENV })
        .done(cb)
        .fail(err => {
            log("⚠️ System Alert: " + (err.message || "Command exit state boundary note"));
            if (cb && typeof cb === "function") {
                try { cb(""); } catch(e) {}
            }
        });
}

function switchTab(t) {
    ['overview','config','media','advanced'].forEach(id => {
        const btn = document.getElementById(`tab-${id}-btn`);
        const content = document.getElementById(`tab-${id}`);
        if(btn) btn.classList.toggle("active", id === t);
        if(content) content.classList.toggle("active-content", id === t);
    });
    if (t === 'config') fetchVMScreenshot();
    if (t === 'media') scanStorageDirectory();
    if (t === 'advanced') syncAdvancedNodeData();
}

function toggleAccordion(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle("show-panel");
    const span = el.previousElementSibling ? el.previousElementSibling.querySelector("span") : null;
    if (span) span.innerText = el.classList.contains("show-panel") ? "▲" : "▼";
}

function initHardwareSliders() {
    _call(["nproc"], text => {
        const mx = parseInt(text.trim(), 10) || 4;
        ['cpu-count','new-vm-cores'].forEach(id => {
            const el = document.getElementById(id);
            if(el) {
                el.max = mx;
                el.style.setProperty('--safe-pct', `${((mx - 1) / mx) * 100}%`);
            }
        });
        const d1 = document.getElementById("cpu-max-display");
        const d2 = document.getElementById("create-cpu-max-display");
        if(d1) d1.innerText = mx + " Cores";
        if(d2) d2.innerText = mx + " Cores";
        updateSliderLabels();
    });

    cockpit.file("/proc/meminfo").read().done(text => {
        const lines = text.split("\n");
        for (let line of lines) {
            if (line.startsWith("MemTotal:")) {
                const parts = line.split(/\s+/);
                if (parts.length > 1) {
                    const mx = Math.floor(parseInt(parts[1], 10) / 1024);
                    ['ram-amount','new-vm-ram'].forEach(id => {
                        const el = document.getElementById(id);
                        if(el) {
                            el.max = mx;
                            el.style.setProperty('--safe-pct', `${((mx - 2048) / mx) * 100}%`);
                        }
                    });
                    const r1 = document.getElementById("ram-max-display");
                    const r2 = document.getElementById("create-ram-max-display");
                    if(r1) r1.innerText = mx + " MB";
                    if(r2) r2.innerText = mx + " MB";
                    updateSliderLabels();
                }
                break;
            }
        }
    });
}

function updateSliderLabels() {
    const ids = ['ram-amount', 'cpu-count', 'new-vm-ram', 'new-vm-cores'];
    const targets = ['ram-val-display', 'cpu-val-display', 'create-ram-val-display', 'create-cpu-val-display'];
    const sufix = [' MB', ' Cores', ' MB', ' Cores'];

    ids.forEach((id, i) => {
        const el = document.getElementById(id);
        const target = document.getElementById(targets[i]);
        if (!el || !target) return;

        const val = parseInt(el.value, 10) || 0;
        target.innerText = val + sufix[i];

        const min = parseFloat(el.min) || 0;
        const max = parseFloat(el.max) || 100;
        const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;

        el.style.background = pct <= 80 ?
            `linear-gradient(to right, #1e8a3b 0%, #1e8a3b ${pct}% , #212427 ${pct}%, #212427 100%)` :
            `linear-gradient(to right, #1e8a3b 0%, #1e8a3b 80%, #c91818 80%, #c91818 ${pct}%, #212427 ${pct}%, #212427 100%)`;
    });
}
function fetchVMScreenshot() {
    const vm = document.getElementById("vm-list").value;
    const canvas = document.getElementById("vbox-screen-canvas");
    if (!canvas) return;
    if (!vm || !runningVMs.includes(vm)) {
        canvas.alt = "[Select a running row node from inventory to view screen]";
        return;
    }
    
    // Command executes correctly
    cockpit.spawn(["vboxmanage", "controlvm", vm, "screenshotpng", SCR_PATH], { env: VBOX_ENV })
        .done(() => {
            // FIX: Bypass binary string conversions entirely.
            // Force an instant graphic refresh using a dynamic cache-busting timestamp token.
            canvas.src = "scr-cache.png?v=" + new Date().getTime();
        })
        .fail(() => {
            canvas.alt = "[Live Monitor available on next scheduled machine reboot]";
        });
}




function startLiveScreenLoop() {
    if (screenLoopInterval) clearInterval(screenLoopInterval);
    screenLoopInterval = setInterval(() => {
        const vm = document.getElementById("vm-list").value;
        if (vm && runningVMs.includes(vm)) fetchVMScreenshot();
    }, 3000);
}

function scanStorageDirectory() {
    const inputEl = document.getElementById("scan-dir-input");
    const path = inputEl ? inputEl.value.trim() : "/var/lib/virtualbox";

    cockpit.spawn(["ls", "-1", path])
        .done(out => {
            ['dir-picker-select', 'media-picker-select'].forEach(id => {
                const el = document.getElementById(id);
                if(!el) return;
                el.innerHTML = "<option value=''>-- Select an image file --</option>";
                if (!out || !out.trim()) return;
                out.trim().split("\n").forEach(f => {
                    if (['.vdi','.iso','.vmdk','.vhd'].some(ext => f.toLowerCase().endsWith(ext))) {
                        el.innerHTML += `<option value="${f}">${f}</option>`;
                    }
                });
            });
        })
        .fail(() => {
            ['dir-picker-select', 'media-picker-select'].forEach(id => {
                const el = document.getElementById(id); if(el) el.innerHTML = "<option value=''>-- Directory unreadable or empty --</option>";
            });
        });
}

function selectFile(srcInput, targetInput) {
    const root = document.getElementById(srcInput).value.trim();
    const file = document.getElementById(targetInput).value;
    if (file) document.getElementById(targetInput.includes("media") ? "media-path" : "vdi-path").value = (root.endsWith("/") ? root : root + "/") + file;
}
function refreshVMs() {
    cockpit.spawn(["vboxmanage", "list", "runningvms"], { env: VBOX_ENV }).done(rOut => {
        runningVMs = (rOut.match(/"([^"]+)"/g) || []).map(m => m.replace(/"/g, ''));
        _call(["vboxmanage", "list", "vms"], out => {
            const tbody = document.getElementById("vm-table-body");
            const cur = document.getElementById("vm-list").value;
            if(!tbody) return;
            tbody.innerHTML = out.trim() ? "" : `<tr><td colspan="4" class="table-placeholder">No VMs registered.</td></tr>`;

            (out.match(/"([^"]+)"/g) || []).map(m => m.replace(/"/g, '')).forEach(name => {
                const tr = document.createElement("tr");
                tr.id = `vm-row-${name}`;
                if (name === cur) tr.className = "selected-table-row";

                tr.onclick = (e) => {
                    if(e.target.tagName !== "BUTTON") {
                        document.getElementById("vm-list").value = name;
                        document.getElementById("config-target-title").innerText = name;
                        refreshVMs();
                        syncAdvancedNodeData();
                    }
                };

                const isRun = runningVMs.includes(name);

                // FIX: Removed forbidden inline 'onclick' attributes entirely
                let controlCellHtml = "";
                if (isRun) {
                    controlCellHtml = `
                        <div class="flex-buttons" style="display: inline-flex; gap: 4px; width: auto; margin: 0px !important;">
                            <button class="danger inline-dense-btn" data-action="stop" data-vm="${name}">🛑 Stop</button>
                            <button class="danger inline-dense-btn" style="background-color: #930000 !important;" data-action="kill" data-vm="${name}">⚡ Kill</button>
                        </div>
                    `;
                } else {
                    controlCellHtml = `<button class="success inline-dense-btn" data-action="start" data-vm="${name}">▶️ Start</button>`;
                }

                tr.innerHTML = `<td><strong>${name}</strong></td><td><span class="status-badge ${isRun?'status-on':'status-off'}">${isRun?'RUNNING':'POWER OFF'}</span></td><td id="ts-${name}">Loading...</td><td>${controlCellHtml}</td>`;
                tbody.appendChild(tr);

                // FIX: Attach event listeners programmatically (100% compliant with Cockpit's CSP)
                tr.querySelectorAll("button[data-action]").forEach(btn => {
                    btn.addEventListener("click", (e) => {
                        e.stopPropagation(); // Prevents row click selection triggers
                        const action = e.target.getAttribute("data-action");
                        const targetVM = e.target.getAttribute("data-vm");
                        window.controlPowerDirectly(targetVM, action);
                    });
                });

                cockpit.spawn(["vboxmanage", "showvminfo", name], { env: VBOX_ENV }).done(info => {
                    let ram = "1024", cpu = "1";
                    const ramMatch = info.match(/Memory size:\s+(\d+)MB/);
                    if (ramMatch && ramMatch[1]) ram = ramMatch[1];
                    const cpuMatch = info.match(/Number of CPUs:\s+(\d+)/);
                    if (cpuMatch && cpuMatch[1]) cpu = cpuMatch[1];

                    const tsCell = document.getElementById(`ts-${name}`);
                    if (tsCell) tsCell.innerText = `${cpu} Cores / ${ram} MB`;

                    if (name === cur) {
                        const ramSlider = document.getElementById("ram-amount");
                        const cpuSlider = document.getElementById("cpu-count");
                        if(ramSlider) ramSlider.value = ram;
                        if(cpuSlider) cpuSlider.value = cpu;

                        detectedStorageController = info.toUpperCase().includes("IDE") ? "IDE" : "SATA";

                        const gfxMatch = info.match(/Graphics controller:\s+([^\n]+)/i);
                        if (gfxMatch && gfxMatch[1]) document.getElementById("gpu-driver").value = gfxMatch[1].toLowerCase().trim();

                        const vramMatch = info.match(/VRAM size:\s+(\d+)MB/i);
                        if (vramMatch && vramMatch[1]) document.getElementById("gpu-vram").value = vramMatch[1];

                        const accelMatch = info.match(/3D Acceleration:\s+([^\n]+)/i);
                        if (accelMatch && accelMatch[1]) document.getElementById("gpu-3d-accelerate").checked = accelMatch[1].toLowerCase().includes("on");

                        document.getElementById("gpu-driver").disabled = isRun;
                        document.getElementById("gpu-vram").disabled = isRun;
                        document.getElementById("gpu-3d-accelerate").disabled = isRun;

                        const vmInfoBox = document.getElementById("vminfo");
                        if(vmInfoBox) {
                            vmInfoBox.innerHTML = `<strong>RAM Budget:</strong> ${ram} MB<br><strong>Cores:</strong> ${cpu}<br><strong>Storage Bus:</strong> ${detectedStorageController}`;
                        }

                        if(ramSlider) ramSlider.disabled = isRun;
                        if(cpuSlider) cpuSlider.disabled = isRun;
                        updateSliderLabels();
                    }
                });
            });
            fetchVMScreenshot();
        });
    });
}

function syncAdvancedNodeData() {
    const vm = document.getElementById("vm-list").value;
    const advTitle = document.getElementById("adv-target-title");
    if(advTitle) advTitle.innerText = vm || "None Selected";
    if (!vm) return;

    cockpit.spawn(["vboxmanage", "snapshot", vm, "list"], { env: VBOX_ENV })
        .done(out => {
            const picker = document.getElementById("snap-picker-select");
            if(!picker) return;
            picker.innerHTML = "";
            const matches = out.match(/Name:\s+([^\s(]+)/g) || [];
            if (!matches.length) picker.innerHTML = "<option value=''>-- No checkpoints exist --</option>";
            matches.forEach(m => {
                const label = m.replace("Name:", "").trim();
                picker.innerHTML += `<option value="${label}">${label}</option>`;
            });
        }).fail(() => {
            const p = document.getElementById("snap-picker-select");
            if(p) p.innerHTML = "<option value=''>-- No checkpoints exist --</option>";
        });

    cockpit.spawn(["vboxmanage", "showvminfo", vm, "--machinereadable"], { env: VBOX_ENV })
        .done(info => {
            const picker = document.getElementById("nat-picker-select");
            if(!picker) return;
            picker.innerHTML = "";
            const lines = info.split("\n");
            let count = 0;
            lines.forEach(line => {
    		// FIX: Match 'Forwarding(any number)=' or 'natpf(any number)=' flexibly
    		if (line.match(/^Forwarding\(\d+\)=/i) || line.match(/^natpf\d+=/i)) {
        		const parts = line.split("=");
        		if (parts.length > 1) {
            		const ruleData = parts[1].replace(/"/g, '').trim();
            		picker.innerHTML += `<option value="${ruleData.split(",")}">${ruleData.replace(/,/g, " | ")}</option>`;
            		count++;
        		}
    		}
	});

            if (!count) picker.innerHTML = "<option value=''>-- No active NAT mapping rules configured --</option>";
        });

    cockpit.spawn(["vboxmanage", "showvminfo", vm, "--machinereadable"], { env: VBOX_ENV })
        .done(info => {
            const picker = document.getElementById("sf-picker-select");
            if(!picker) return;
            picker.innerHTML = "";
            const lines = info.split("\n");
            let shares = {};
            lines.forEach(line => {
                if (line.startsWith("SharedFolderNameMachineMapping")) {
                    const idxMatch = line.match(/\d+/);
                    if(idxMatch) {
                        const idx = idxMatch[0];
                        // FIX: Safe string selection parsing array check
                        const parts = line.split("=");
                        if (parts.length > 1) {
                            const name = parts[1].replace(/"/g, '').trim();
                            if(!shares[idx]) shares[idx] = {};
                            shares[idx].name = name;
                        }
                    }
                }
                if (line.startsWith("SharedFolderPathMachineMapping")) {
                    const idxMatch = line.match(/\d+/);
                    if(idxMatch) {
                        const idx = idxMatch[0];
                        // FIX: Safe string selection parsing array check
                        const parts = line.split("=");
                        if (parts.length > 1) {
                            const path = parts[1].replace(/"/g, '').trim();
                            if(!shares[idx]) shares[idx] = {};
                            shares[idx].path = path;
                        }
                    }
                }
            });
            let count = 0;
	    for (let idx in shares) {
    		// FIX: Fall back cleanly to a readable string if the path string is missing
    		if (shares[idx].name) {
        	const folderPath = shares[idx].path || "[Path Locked / Unreadable]";
        	picker.innerHTML += `<option value="${shares[idx].name}">${shares[idx].name} ➔ ${folderPath}</option>`;
        	count++;
    		}
	    }

            if (!count) picker.innerHTML = "<option value=''>-- No host shared folders mounted --</option>";
        });
}


window.controlPowerDirectly = function(name, act) {
    document.getElementById("vm-list").value = name;

    let cmd;
    if (act === 'start') {
        cmd = ["vboxmanage", "startvm", name, "--type", "headless"];
    } else if (act === 'stop') {
        cmd = ["vboxmanage", "controlvm", name, "acpipowerbutton"];
    } else if (act === 'kill') {
        cmd = ["vboxmanage", "controlvm", name, "poweroff"];
    }

    if (cmd) {
        _call(cmd, () => setTimeout(refreshVMs, 1000));
    }
};

document.getElementById("tab-overview-btn").addEventListener("click", () => switchTab('overview'));
document.getElementById("tab-config-btn").addEventListener("click", () => switchTab('config'));
document.getElementById("tab-media-btn").addEventListener("click", () => switchTab('media'));
document.getElementById("tab-advanced-btn").addEventListener("click", () => switchTab('advanced'));
document.getElementById("refresh-btn").addEventListener("click", refreshVMs);
document.getElementById("acc-trigger-snapshots").addEventListener("click", () => toggleAccordion('acc-snapshots'));
document.getElementById("acc-trigger-create-vm").addEventListener("click", () => toggleAccordion('acc-create-vm'));
document.getElementById("acc-trigger-nat").addEventListener("click", () => toggleAccordion('acc-nat'));
document.getElementById("acc-trigger-shared").addEventListener("click", () => toggleAccordion('acc-shared'));
document.getElementById("snap-take-btn").addEventListener("click", () => { const vm = document.getElementById("vm-list").value, lbl = document.getElementById("snap-name").value.trim(); if(lbl) _call(["vboxmanage", "snapshot", vm, "take", lbl], () => { document.getElementById("snap-name").value = ""; syncAdvancedNodeData(); }); });
document.getElementById("snap-restore-btn").addEventListener("click", () => { const vm = document.getElementById("vm-list").value, lbl = document.getElementById("snap-picker-select").value; if(lbl) _call(["vboxmanage", "snapshot", vm, "restore", lbl], refreshVMs); });
document.getElementById("snap-delete-btn").addEventListener("click", () => { const vm = document.getElementById("vm-list").value, lbl = document.getElementById("snap-picker-select").value; if(lbl && confirm(`Wipe checkpoint ${lbl}?`)) _call(["vboxmanage", "snapshot", vm, "delete", lbl], syncAdvancedNodeData); });
document.getElementById("nat-add-btn").addEventListener("click", () => { const vm = document.getElementById("vm-list").value, lbl = document.getElementById("nat-rule-name").value.trim(), proto = document.getElementById("nat-proto").value, hPort = document.getElementById("nat-host-port").value, gPort = document.getElementById("nat-guest-port").value; if(lbl && hPort && gPort) _call(["vboxmanage", "modifyvm", vm, "--natpf1", `${lbl},${proto},,${hPort},,${gPort}`], () => { document.getElementById("nat-rule-name").value = ""; syncAdvancedNodeData(); }); });
document.getElementById("nat-del-btn").addEventListener("click", () => { const vm = document.getElementById("vm-list").value, lbl = document.getElementById("nat-picker-select").value; if(lbl) _call(["vboxmanage", "modifyvm", vm, "--natpf1", "delete", lbl], syncAdvancedNodeData); });
document.getElementById("sf-add-btn").addEventListener("click", () => { const vm = document.getElementById("vm-list").value, name = document.getElementById("sf-name").value.trim(), path = document.getElementById("sf-path").value.trim(), auto = document.getElementById("sf-automount").checked; if(name && path) { let args = ["vboxmanage", "sharedfolder", "add", vm, "--name", name, "--hostpath", path]; if(auto) args.push("--automount"); _call(args, () => { document.getElementById("sf-name").value = document.getElementById("sf-path").value = ""; syncAdvancedNodeData(); }); } });
document.getElementById("sf-del-btn").addEventListener("click", () => { const vm = document.getElementById("vm-list").value, name = document.getElementById("sf-picker-select").value; if(name) _call(["vboxmanage", "sharedfolder", "remove", vm, "--name", name], syncAdvancedNodeData); });
document.getElementById("save-hw-btn").addEventListener("click", () => { const vm = document.getElementById("vm-list").value, ram = document.getElementById("ram-amount").value, cpu = document.getElementById("cpu-count").value, gfx = document.getElementById("gpu-driver").value, vram = document.getElementById("gpu-vram").value, accel = document.getElementById("gpu-3d-accelerate").checked ? "on" : "off"; if(vm) _call(["vboxmanage", "modifyvm", vm, "--memory", ram, "--cpus", cpu, "--graphicscontroller", gfx, "--vram", vram, "--accelerate3d", accel], refreshVMs); });
document.getElementById("create-vm-btn").addEventListener("click", () => _call(["vboxmanage", "createvm", "--name", document.getElementById("new-vm-name").value, "--ostype", document.getElementById("new-vm-ostype").value, "--register"], () => _call(["vboxmanage", "modifyvm", document.getElementById("new-vm-name").value, "--memory", document.getElementById("new-vm-ram").value, "--cpus", document.getElementById("new-vm-cores").value], refreshVMs)));
document.getElementById("delete-vm-btn").addEventListener("click", () => { const vm = document.getElementById("vm-list").value; let args = ["vboxmanage", "unregistervm", vm]; if(document.getElementById("delete-files-check").checked) args.push("--delete"); if(confirm(`Destroy ${vm}?`)) _call(args, refreshVMs); });
document.getElementById("scan-dir-btn").addEventListener("click", scanStorageDirectory);
document.getElementById("dir-picker-select").addEventListener("change", () => selectFile("scan-dir-input", "dir-picker-select"));
document.getElementById("attach-btn").addEventListener("click", () => _call(["vboxmanage", "storageattach", document.getElementById("vm-list").value, "--storagectl", detectedStorageController, "--port", "0", "--device", "0", "--type", document.getElementById("vdi-path").value.endsWith(".iso")?"dvddrive":"hdd", "--medium", document.getElementById("vdi-path").value], refreshVMs));
document.getElementById("detach-btn").addEventListener("click", () => _call(["vboxmanage", "storageattach", document.getElementById("vm-list").value, "--storagectl", detectedStorageController, "--port", "0", "--device", "0", "--type", "none"], refreshVMs));
document.getElementById("media-create-btn").addEventListener("click", () => _call(["vboxmanage", "createmedium", "disk", "--filename", document.getElementById("media-path").value, "--size", document.getElementById("media-size").value*1024, "--format", document.getElementById("media-format").value.toUpperCase(), "--variant", document.getElementById("media-preallocate").checked?"Fixed":"Standard"], scanStorageDirectory));
document.getElementById("media-resize-btn").addEventListener("click", () => _call(["vboxmanage", "modifymedium", "disk", document.getElementById("media-path").value, "--resize", document.getElementById("media-size").value*1024], scanStorageDirectory));
document.getElementById("media-delete-btn").addEventListener("click", () => { if(confirm("Delete disk?")) _call(["vboxmanage", "closemedium", "disk", document.getElementById("media-path").value, "--delete"], scanStorageDirectory); });
document.getElementById("media-scan-dir-btn").addEventListener("click", () => { document.getElementById("scan-dir-input").value = document.getElementById("media-scan-dir-input").value; scanStorageDirectory(); });
document.getElementById("media-picker-select").addEventListener("change", () => selectFile("media-scan-dir-input", "media-picker-select"));

['ram-amount', 'cpu-count', 'new-vm-ram', 'new-vm-cores'].forEach(id => {
    const el = document.getElementById(id); if(el) el.addEventListener("input", updateSliderLabels);
});

window.toggleAccordion = toggleAccordion;

resolveHostIdentity(() => {
    initHardwareSliders();
    _call(["vboxmanage", "list", "ostypes"], out => {
        const sel = document.getElementById("new-vm-ostype"); if(!sel) return; sel.innerHTML = "";
        (out.match(/ID:\s+([^\n]+)/g) || []).map(m => m.replace("ID:", "").trim()).forEach(id => { sel.innerHTML += `<option value="${id}">${id}</option>`; });
        sel.value = "Ubuntu_64";
    });
    refreshVMs();
    startLiveScreenLoop();
});
