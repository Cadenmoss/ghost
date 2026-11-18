#!/usr/bin/env python3
"""Build the Spoof / Real Location shortcuts as .shortcut files.

Action identifiers, parameter keys and enum values come from Apple's own
ToolKit catalog on this Mac (~/Library/Shortcuts/ToolKit), not from memory.
The LocalDevVPN configuration differs per phone; it's copied from the Spoof
already in your library, if there is one.
"""
import plistlib, uuid, os

HERE = os.path.dirname(os.path.abspath(__file__))
STIK = {"AppIntentIdentifier": None, "BundleIdentifier": "com.caden.ghost.stikdebug",
        "Name": "StikDebug", "TeamIdentifier": "8569X4THC7"}

def stik(intent, **params):
    desc = dict(STIK, AppIntentIdentifier=intent)
    return {"WFWorkflowActionIdentifier": f"com.caden.ghost.stikdebug.{intent}",
            "WFWorkflowActionParameters": {"AppIntentDescriptor": desc, "UUID": str(uuid.uuid4()).upper(), **params}}

def act(ident, **params):
    return {"WFWorkflowActionIdentifier": ident,
            "WFWorkflowActionParameters": {"UUID": str(uuid.uuid4()).upper(), **params}}

def var_ref(action, name):
    """A text field holding another action's output (the ￼ token)."""
    return {"Value": {"string": "￼",
                      "attachmentsByRange": {"{0, 1}": {"OutputName": name, "Type": "ActionOutput",
                                                       "OutputUUID": action["WFWorkflowActionParameters"]["UUID"]}}},
            "WFSerializationType": "WFTextTokenString"}

def workflow(actions, questions=(), glyph=59511, color=463140863):
    return {"WFWorkflowActions": actions,
            "WFWorkflowClientVersion": "2607.0.2",
            "WFWorkflowMinimumClientVersion": 900, "WFWorkflowMinimumClientVersionString": "900",
            "WFWorkflowIcon": {"WFWorkflowIconGlyphNumber": glyph, "WFWorkflowIconStartColor": color},
            "WFWorkflowImportQuestions": list(questions),
            "WFWorkflowInputContentItemClasses": [], "WFWorkflowOutputContentItemClasses": [],
            "WFWorkflowTypes": [], "WFQuickActionSurfaces": [], "WFWorkflowHasOutputFallback": False}

def attach(action, name):
    """A whole-variable slot (not text) holding another action's output."""
    return {"Value": {"OutputName": name, "Type": "ActionOutput",
                      "OutputUUID": action["WFWorkflowActionParameters"]["UUID"]},
            "WFSerializationType": "WFTextTokenAttachment"}

def block(ident, start_params, middle=(), end_uuid=True):
    """Control-flow block: [start, *middles, end] sharing one GroupingIdentifier.
    `middle` is a list of (params, [actions]) for Otherwise / menu items."""
    g = str(uuid.uuid4()).upper()
    def piece(mode, **p):
        return {"WFWorkflowActionIdentifier": ident,
                "WFWorkflowActionParameters": {"GroupingIdentifier": g, "WFControlFlowMode": mode, **p}}
    out = [piece(0, **start_params[0]), *start_params[1]]
    for params, body in middle:
        out += [piece(1, **params), *body]
    end = piece(2, UUID=str(uuid.uuid4()).upper())
    return out + [end], end

# LocalDevVPN, as you picked it on the phone (read back from your library), so
# a rebuilt Spoof doesn't need the VPN chosen again. Falls back to asking.
def your_vpn():
    import sqlite3, tempfile
    db = os.path.expanduser("~/Library/Shortcuts/Shortcuts.sqlite")
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        for (data,) in con.execute("select a.ZDATA from ZSHORTCUTACTIONS a join ZSHORTCUT s on a.ZSHORTCUT=s.Z_PK where s.ZNAME='Spoof'"):
            for a in plistlib.loads(data):
                v = a.get("WFWorkflowActionParameters", {}).get("WFVPN")
                if v: return v
    except Exception as e:
        print("couldn't read your VPN choice:", e)
    return None

# --- Spoof -----------------------------------------------------------------
# Order matters. Location simulation builds its own tunnel the first time it
# sets a location, and iOS won't build that tunnel while Cellular Data is on.
# Looking a place up needs internet; setting the location doesn't. So: look up
# first, then set the location inside the cellular-off window.
#
# Menu: your saved places + "Somewhere else…" (which asks for an address).
places   = stik("GhostListPlacesIntent", includeOther=True)
pick     = act("is.workflow.actions.choosefromlist", WFInput=attach(places, "Saved Places"),
               WFChooseFromListActionPrompt="Where to?")
ask      = act("is.workflow.actions.ask", WFAskActionPrompt="Where to?", WFInputType="Text")
chosen   = act("is.workflow.actions.gettext", WFTextActionText=var_ref(pick, "Chosen Item"))
if_blk, if_end = block("is.workflow.actions.conditional",
    ({"WFCondition": 4, "WFConditionalActionString": "Somewhere else…",
      "WFInput": {"Type": "Variable", "Variable": attach(pick, "Chosen Item")}}, [ask]),
    middle=[({}, [chosen])])
find     = stik("GhostFindPlaceIntent", place=var_ref(if_end, "If Result"))
vpn_cfg  = your_vpn()
vpn      = act("is.workflow.actions.vpn.set", WFVPNOperation="Connect", **({"WFVPN": vpn_cfg} if vpn_cfg else {}))
cell_off = act("is.workflow.actions.cellulardata.set", operation="set", OnValue=False)
settle   = act("is.workflow.actions.delay")   # you added this one-second Wait; kept
go       = stik("GhostSimulateLocationIntent", place=var_ref(find, "Find Place"))
cell_on  = act("is.workflow.actions.cellulardata.set", operation="set", OnValue=True)
spoof = [places, pick, *if_blk, find, vpn, cell_off, settle, go, cell_on]

# --- Save Place ------------------------------------------------------------
name     = act("is.workflow.actions.ask", WFAskActionPrompt="Name this place (e.g. My Dorm)", WFInputType="Text")
here     = act("is.workflow.actions.getcurrentlocation")
save_here = stik("GhostSavePlaceIntent", name=var_ref(name, "Provided Input"), location=attach(here, "Current Location"))
addr     = act("is.workflow.actions.ask", WFAskActionPrompt="Address or place", WFInputType="Text")
save_addr = stik("GhostSavePlaceIntent", name=var_ref(name, "Provided Input"), place=var_ref(addr, "Provided Input"))
HERE_OPT, ADDR_OPT = "Where I am now", "Type an address"
menu, _ = block("is.workflow.actions.choosefrommenu",
    ({"WFMenuPrompt": "Where is it?", "WFMenuItems": [HERE_OPT, ADDR_OPT]}, []),
    middle=[({"WFMenuItemTitle": HERE_OPT}, [here, save_here]),
            ({"WFMenuItemTitle": ADDR_OPT}, [addr, save_addr])])
save = [name, *menu]

# --- Forget Place ----------------------------------------------------------
fplaces  = stik("GhostListPlacesIntent", includeOther=False)
fpick    = act("is.workflow.actions.choosefromlist", WFInput=attach(fplaces, "Saved Places"),
               WFChooseFromListActionPrompt="Forget which place?")
forget   = [fplaces, fpick, stik("GhostForgetPlaceIntent", name=var_ref(fpick, "Chosen Item"))]

# --- Real Location ---------------------------------------------------------
real = [stik("GhostClearLocationIntent")]

for title, wf in (("Spoof", workflow(spoof)), ("Real Location", workflow(real, glyph=59448, color=4251333119)),
                  ("Save Place", workflow(save, color=4292093695)), ("Forget Place", workflow(forget, glyph=59448, color=4251333119))):
    path = os.path.join(HERE, f"{title}.unsigned.shortcut")
    with open(path, "wb") as f:
        plistlib.dump(wf, f, fmt=plistlib.FMT_BINARY)
    print("wrote", os.path.basename(path), f"({len(wf['WFWorkflowActions'])} actions)")
