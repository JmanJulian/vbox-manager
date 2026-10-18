#!/usr/bin/env python3
import sys
import json
import subprocess
import re
import os

def run_cmd(args):
    try:
        res = subprocess.run(args, capture_output=True, text=True, check=True)
        return res.stdout
    except Exception:
        return ""

def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Missing parameters"}))
        return

    action = sys.argv[1]
    try:
        p = json.loads(sys.argv[2])
    except Exception:
        print(json.dumps({"error": "Invalid arguments object JSON"}))
        return

    res_data = {}

    if action == "host_limits":
        nproc = run_cmd(["nproc"]).strip()
        cpu_max = int(nproc) if nproc.isdigit() else 4
        ram_max = 4096
        try:
            with open("/proc/meminfo", "r") as f:
                for line in f:
                    if line.startswith("MemTotal:"):
                        ram_max = int(line.split()[1]) // 1024
                        break
        except Exception:
            pass
        os_out = run_cmd(["vboxmanage", "list", "ostypes"])
        ostypes = [m.replace("ID:", "").strip() for m in re.findall(r'ID:\s+([^\n]+)', os_out)]
        res_data = {"cpu": cpu_max, "ram": ram_max, "ostypes": ostypes}

    elif action == "list_vms":
        running_out = run_cmd(["vboxmanage", "list", "runningvms"])
        running = [m.replace('"', '') for m in re.findall(r'"([^"]+)"', running_out)]
        all_out = run_cmd(["vboxmanage", "list", "vms"])
        all_vms = [m.replace('"', '') for m in re.findall(r'"([^"]+)"', all_out)]
        
        vms = []
        for name in all_vms:
            info = run_cmd(["vboxmanage", "showvminfo", name])
            ram = "1024"
            ram_m = re.search(r'Memory size:\s+(\d+)MB', info)
            if ram_m: ram = ram_m.group(1)
            
            cpu = "1"
            cpu_m = re.search(r'Number of CPUs:\s+(\d+)', info)
            if cpu_m: cpu = cpu_m.group(1)
                
            gfx = "vmsvga"
            gfx_m = re.search(r'Graphics controller:\s+([^\n]+)', info, re.IGNORECASE)
            if gfx_m: gfx = gfx_m.group(1).lower().strip()
                
            vram = "16"
            vram_m = re.search(r'VRAM size:\s+(\d+)MB', info, re.IGNORECASE)
            if vram_m: vram = vram_m.group(1)
                
            accel = "off"
            accel_m = re.search(r'3D Acceleration:\s+([^\n]+)', info, re.IGNORECASE)
            if accel_m and "on" in accel_m.group(1).lower(): accel = "on"
                
            vms.append({
                "name": name, "running": name in running, "ram": ram, "cpu": cpu,
                "controller": "IDE" if "IDE" in info.upper() else "SATA",
                "gfx": gfx, "vram": vram, "accel": accel, "selected": (name == p.get("current"))
            })
        res_data = {"vms": vms, "running": running}

    elif action == "advanced_info":
        vm = p.get("vm")
        snap_out = run_cmd(["vboxmanage", "snapshot", vm, "list"])
        snapshots = [m.replace("Name:", "").strip() for m in re.findall(r'Name:\s+([^\s(]+)', snap_out)]
        m_info = run_cmd(["vboxmanage", "showvminfo", vm, "--machinereadable"])
        
        nat_rules = []
        shares = {}
        for line in m_info.splitlines():
            if line.startswith("Forwarding") or line.startswith("natpf"):
                parts = line.split("=")
                if len(parts) > 1: nat_rules.append(parts[1].replace('"', '').strip())
            if "SharedFolderNameMachineMapping" in line:
                idx = re.search(r'\d+', line).group()
                shares.setdefault(idx, {})["name"] = line.split("=").replace('"', '').strip()
            elif "SharedFolderPathMachineMapping" in line:
                idx = re.search(r'\d+', line).group()
                shares.setdefault(idx, {})["path"] = line.split("=").replace('"', '').strip()
        
        res_data = {
            "snapshots": snapshots, "nat_rules": nat_rules,
            "shared_folders": [{"name": v["name"], "path": v.get("path", "[Unreadable]")} for k, v in shares.items() if "name" in v]
        }

    elif action == "get_screenshot":
        vm = p.get("vm")
        if vm:
            run_cmd(["vboxmanage", "controlvm", vm, "screenshotpng", "scr-cache.png"])
            res_data = {"src": "scr-cache.png" if os.path.exists("scr-cache.png") else ""}

    elif action == "scan_dir":
        path = p.get("path", "/var/lib/virtualbox")
        files = []
        if os.path.exists(path):
            try:
                files = [f for f in os.listdir(path) if f.lower().endswith(('.vdi', '.iso', '.vmdk', '.vhd'))]
            except Exception:
                pass
        res_data = {"files": files}

    elif action == "power_action":
        vm, act = p.get("vm"), p.get("action")
        cmd = ["vboxmanage", "startvm", vm, "--type", "headless"] if act == "start" else ["vboxmanage", "controlvm", vm, "acpipowerbutton" if act == "stop" else "poweroff"]
        run_cmd(cmd)
        res_data = {"status": "success"}

    elif action == "save_hw":
        run_cmd(["vboxmanage", "modifyvm", p.get("vm"), "--memory", p.get("ram"), "--cpus", p.get("cpu"), "--graphicscontroller", p.get("gfx"), "--vram", p.get("vram"), "--accelerate3d", p.get("accel")])
        res_data = {"status": "success"}

    elif action == "create_vm":
        name = p.get("name")
        run_cmd(["vboxmanage", "createvm", "--name", name, "--ostype", p.get("ostype"), "--register"])
        run_cmd(["vboxmanage", "modifyvm", name, "--memory", p.get("ram"), "--cpus", p.get("cpu")])
        res_data = {"status": "success"}

    elif action == "delete_vm":
        args = ["vboxmanage", "unregistervm", p.get("vm")]
        if p.get("files"): args.append("--delete")
        run_cmd(args)
        res_data = {"status": "success"}

    elif action == "attach_disk":
        run_cmd(["vboxmanage", "storageattach", p.get("vm"), "--storagectl", p.get("ctrl"), "--port", "0", "--device", "0", "--type", "dvddrive" if p.get("path", "").endswith(".iso") else "hdd", "--medium", p.get("path")])
        res_data = {"status": "success"}

    elif action == "detach_disk":
        run_cmd(["vboxmanage", "storageattach", p.get("vm"), "--storagectl", p.get("ctrl"), "--port", "0", "--device", "0", "--type", "none"])
        res_data = {"status": "success"}

    elif action == "take_snap":
        run_cmd(["vboxmanage", "snapshot", p.get("vm"), "take", p.get("name")])
        res_data = {"status": "success"}

    elif action == "restore_snap":
        run_cmd(["vboxmanage", "snapshot", p.get("vm"), "restore", p.get("name")])
        res_data = {"status": "success"}

    elif action == "delete_snap":
        run_cmd(["vboxmanage", "snapshot", p.get("vm"), "delete", p.get("name")])
        res_data = {"status": "success"}

    elif action == "add_nat":
        rule = f"{p.get('name')},{p.get('proto')},,{p.get('hport')},Lenovo,{p.get('gport')}"
        run_cmd(["vboxmanage", "modifyvm", p.get("vm"), "--natpf1", rule])
        res_data = {"status": "success"}

    elif action == "del_nat":
        run_cmd(["vboxmanage", "modifyvm", p.get("vm"), "--natpf1", "delete", p.get("rule")])
        res_data = {"status": "success"}

    elif action == "add_share":
        args = ["vboxmanage", "sharedfolder", "add", p.get("vm"), "--name", p.get("name"), "--hostpath", p.get("path")]
        if p.get("auto"): args.append("--automount")
        run_cmd(args)
        res_data = {"status": "success"}

    elif action == "del_share":
        run_cmd(["vboxmanage", "sharedfolder", "remove", p.get("vm"), "--name", p.get("name")])
        res_data = {"status": "success"}

    print(json.dumps(res_data))

if __name__ == "__main__":
    main()
