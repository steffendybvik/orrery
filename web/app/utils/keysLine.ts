/**
 * A line for a terminal that adds an agent key to ~/.config/orrery/keys.json for the orrery at `origin`, keeping what's
 * there, readable by you alone (ORR-825). It's the file the launcher service and the sessions it starts read their key
 * from, as a service gets nothing from your shell. orrery runs in a container, so it can't write the file itself.
 */
export const keysLine = (origin: string, key: string) =>
    `node -e 'const fs=require("fs"),p=require("path"),f=p.join(process.env.XDG_CONFIG_HOME||p.join(require("os").homedir(),".config"),"orrery","keys.json");let k={};try{k=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}k[process.argv[1]]=process.argv[2];fs.mkdirSync(p.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(k,null,2)+"\\n",{mode:0o600});fs.chmodSync(f,0o600)' '${origin}' '${key}'`
