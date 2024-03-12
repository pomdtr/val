import { Command, open, Table, toText, esbuild, denoPlugins } from "./deps.ts";
import { loadUser } from "./lib.ts";
import {
  editText,
  fetchValTown,
  parseVal,
  printAsJSON,
  printCode,
  valtownToken,
} from "./lib.ts";

type Val = {
  name: string;
  author: {
    username: string;
  };
  privacy: "private" | "unlisted" | "public";
  version: number;
};

export const valCmd = new Command()
  .name("val")
  .description("Manage Vals.")
  .action(() => {
    valCmd.showHelp();
  });

valCmd
  .command("create")
  .description("Create a new val")
  .option("--privacy <privacy:string>", "privacy of the val")
  .arguments("[name:string]")
  .action(async (options, name) => {
    let code: string;
    if (Deno.stdin.isTerminal()) {
      code = await editText("", "tsx");
    } else {
      code = await toText(Deno.stdin.readable);
    }

    const createResp = await fetchValTown("/v1/vals", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        privacy: options.privacy,
        code,
      }),
    });

    if (!createResp.ok) {
      console.error(await createResp.text());
      Deno.exit(1);
    }

    const val = await createResp.json();

    console.log(
      `Created val ${val.name}, available at https://val.town/v/${val.author.username}/${val.name}`
    );
  });

valCmd
  .command("bundle")
  .description("Bundle a val")
  .arguments("<val:string>")
  .action(async (_, val) => {
    const { author, name } = await parseVal(val);
    const tempfile = await Deno.makeTempFile({
      suffix: ".js",
    });
    await esbuild.build({
      plugins: [...denoPlugins()],
      entryPoints: [`https://esm.town/v/${author}/${name}`],
      outfile: tempfile,
      sourcemap: false,
      bundle: true,
      format: "esm",
      jsx: "automatic",
    });

    esbuild.stop();
    const code = Deno.readTextFileSync(tempfile);
    Deno.removeSync(tempfile);
    console.log(code);
  });

valCmd
  .command("delete")
  .description("Delete a val")
  .arguments("<val:string>")
  .action(async (_, ...args) => {
    const { author, name } = await parseVal(args[0]);

    const getResp = await fetchValTown(`/v1/alias/${author}/${name}`);
    if (!getResp.ok) {
      console.error(await getResp.text());
      Deno.exit(1);
    }
    const val = await getResp.json();

    const deleteResp = await fetchValTown(`/v1/vals/${val.id}`, {
      method: "DELETE",
    });
    if (!deleteResp.ok) {
      console.error(await deleteResp.text());
      Deno.exit(1);
    }

    console.log(`Val ${author}/${name} deleted successfully`);
  });

valCmd
  .command("rename")
  .description("Rename a val")
  .arguments("<old-name> <new-name>")
  .action(async (_, oldName, newName) => {
    const { author, name } = await parseVal(oldName);

    const getResp = await fetch(`/v1/alias/${author}/${name}`);
    if (!getResp.ok) {
      console.error(await getResp.text());
      Deno.exit(1);
    }
    const val = await getResp.json();

    const renameResp = await fetch(`/v1/vals/${val.id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: newName,
      }),
    });
    if (!renameResp.ok) {
      console.error(await renameResp.text());
      Deno.exit(1);
    }

    console.log("Val rename successfully");
  });

valCmd
  .command("edit")
  .description("Edit a val in the system editor.")
  .option("--privacy <privacy:string>", "Privacy of the val")
  .option("--readme", "Edit the readme instead of the code")
  .arguments("<val:string>")
  .action(async (options, valName) => {
    const { author, name } = await parseVal(valName);
    const getResp = await fetchValTown(`/v1/alias/${author}/${name}`);
    if (getResp.status !== 200) {
      console.error(getResp.statusText);
      Deno.exit(1);
    }
    const val = await getResp.json();

    if (options.privacy) {
      if (val.privacy === options.privacy) {
        console.error("No privacy changes.");
        return;
      }

      const resp = await fetchValTown(`/v1/vals/${val.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ privacy: options.privacy }),
      });

      if (!resp.ok) {
        console.error(await resp.json());
        Deno.exit(1);
      }

      console.log(
        `Updated val ${val.author.username}/${val.name} privacy to ${options.privacy}`
      );
      return;
    }

    if (options.readme) {
      let readme: string;
      if (Deno.stdin.isTerminal()) {
        readme = await editText(val.readme || "", "md");
      } else {
        readme = await toText(Deno.stdin.readable);
      }

      const updateResp = await fetchValTown(`/v1/vals/${val.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ readme }),
      });

      if (!updateResp.ok) {
        console.error(updateResp.statusText);
        Deno.exit(1);
      }

      console.log(`Updated val ${val.author.username}/${val.name} readme`);
      Deno.exit(0);
    }

    let code: string;
    if (Deno.stdin.isTerminal()) {
      code = await editText(val.code, "tsx");
    } else {
      code = await toText(Deno.stdin.readable);
    }

    const updateResp = await fetchValTown(`/v1/vals/${val.id}/versions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code }),
    });

    if (!updateResp.ok) {
      console.error(updateResp.statusText);
      Deno.exit(1);
    }

    console.log(`Updated val ${val.author.username}/${val.name}`);
  });

valCmd
  .command("view")
  .description("View val code.")
  .option("-w, --web", "View in browser")
  .option("--readme", "View readme")
  .option("--code", "View code")
  .option("--json", "View as JSON")
  .arguments("<val:string>")
  .action(async (flags, val) => {
    const { author, name } = await parseVal(val);
    if (flags.web) {
      open(`https://val.town/v/${author}.${name}`);
      Deno.exit(0);
    }

    const resp = await fetchValTown(`/v1/alias/${author}/${name}`);

    if (resp.status != 200) {
      console.error(resp.statusText);
      Deno.exit(1);
    }

    const body = await resp.json();

    if (flags.json) {
      printAsJSON(body);
      Deno.exit(0);
    }

    const { readme, code } = body;

    if (flags.readme) {
      printCode("markdown", readme || "");
      return;
    }

    if (flags.code) {
      // @ts-ignore: strange fets issue
      printCode("typescript", code);
      return;
    }

    if (Deno.stdout.isTerminal()) {
      // @ts-ignore: strange fets issue
      printCode("typescript", code);
    } else {
      console.log(code);
    }
  });

valCmd
  .command("search")
  .description("Search vals.")
  .arguments("<query:string>")
  .option("--limit <limit:number>", "Limit", {
    default: 10,
  })
  .action(async (options, query) => {
    const resp = await fetchValTown(
      `/v1/search/vals?query=${encodeURIComponent(query)}&limit=${
        options.limit
      }`
    );
    const { data } = await resp.json();
    if (!data) {
      console.error("invalid response");
      Deno.exit(1);
    }
    const rows = data.map((val: Val) => {
      const slug = `${val.author?.username}/${val.name}`;
      const link = `https://val.town/v/${slug}`;
      return [slug, `v${val.version}`, link];
    }) as string[][];

    if (Deno.stdout.isTerminal()) {
      const table = new Table(...rows).header(["slug", "version", "link"]);
      table.render();
    } else {
      console.log(rows.map((row) => row.join("\t")).join("\n"));
    }
  });

valCmd
  .command("list")
  .description("List user vals.")
  .option("--user <user:string>", "User")
  .option("--limit <limit:number>", "Limit", {
    default: 10,
  })
  .action(async (options) => {
    let userID: string;
    if (options.user) {
      const resp = await fetchValTown(`/v1/alias/${options.user}`);
      if (!resp.ok) {
        console.error(await resp.text);
        Deno.exit(1);
      }
      const user = await resp.json();
      userID = user.id;
    } else {
      const user = await loadUser();
      userID = user.id;
    }

    const resp = await fetchValTown(
      `/v1/users/${userID}/vals?limit=${options.limit}`
    );
    if (!resp.ok) {
      console.error(await resp.text());
      Deno.exit(1);
    }

    const { data } = await resp.json();
    if (!data) {
      console.error("invalid response");
      Deno.exit(1);
    }
    const rows = data.map((val: Val) => {
      const slug = `${val.author?.username}/${val.name}`;
      const link = `https://val.town/v/${slug}`;
      return [slug, `v${val.version}`, link];
    }) as string[][];

    if (Deno.stdout.isTerminal()) {
      const table = new Table(...rows).header(["slug", "version", "link"]);
      table.render();
    } else {
      console.log(rows.map((row) => row.join("\t")).join("\n"));
    }
  });

valCmd
  .command("run")
  .description("Run a val.")
  .stopEarly()
  .arguments("<val:string> [args...]")
  .action(async (_, val, ...args) => {
    const { author, name } = await parseVal(val);

    const { success } = new Deno.Command("deno", {
      args: [
        "run",
        "--allow-all",
        "--quiet",
        "--reload=https://esm.town/v/",
        `https://esm.town/v/${author}/${name}`,
        ...args,
      ],
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: {
        DENO_AUTH_TOKENS: `${valtownToken}@esm.town`,
      },
    }).outputSync();

    if (!success) {
      Deno.exit(1);
    }
  });

valCmd
  .command("install")
  .description("Install a val.")
  .arguments("<val:string>")
  .option("--name <name:string>", "Executable file name")
  .action(async (options, val) => {
    const { author, name } = await parseVal(val);

    const { success } = new Deno.Command("deno", {
      args: [
        "install",
        "--allow-all",
        "--quiet",
        `--name=${options.name || name}`,
        "--reload=https://esm.town/v/",
        `https://esm.town/v/${author}/${name}`,
      ],
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).outputSync();

    if (!success) {
      Deno.exit(1);
    }
  });
