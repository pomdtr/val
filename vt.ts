import {
  Command,
  CompletionsCommand,
} from "https://deno.land/x/cliffy@v1.0.0-rc.2/command/mod.ts";
import { Table } from "https://deno.land/x/cliffy@v1.0.0-rc.2/table/mod.ts";
import * as shlex from "npm:shlex";
import { apiRoot, client } from "./client.ts";
import { emphasize } from "npm:emphasize";
import { open } from "https://deno.land/x/open@v0.0.6/index.ts";
import { readAllSync } from "https://deno.land/std@0.198.0/streams/read_all.ts";

export function splitVal(val: string) {
  if (val.startsWith("@")) {
    val = val.slice(1);
  }

  const [author, name] = val.split(".");
  return { author, name };
}

function printCode(language: string, value: string) {
  if (Deno.isatty(Deno.stdout.rid)) {
    console.log(emphasize.highlight(language, value).value);
  } else {
    console.log(value);
  }
}

function printAsJSON(obj: unknown) {
  if (Deno.isatty(Deno.stdout.rid)) {
    console.log(
      emphasize.highlight("json", JSON.stringify(obj, null, 2)).value
    );
  } else {
    console.log(JSON.stringify(obj));
  }
}

async function editText(text: string, extension: string) {
  const tempfile = await Deno.makeTempFile({
    suffix: `.${extension}`,
  });
  await Deno.writeTextFile(tempfile, text);
  const editor = Deno.env.get("EDITOR") || "vim";
  const [name, ...args] = [...shlex.split(editor), tempfile];

  const command = new Deno.Command(name, {
    args,
    stdin: "inherit",
    stderr: "inherit",
    stdout: "inherit",
  });

  const { code } = await command.output();
  if (code !== 0) {
    console.error(`editor exited with code ${code}`);
    Deno.exit(1);
  }

  return Deno.readTextFile(tempfile);
}

const rootCmd = new Command()
  .name("vt")
  .globalEnv("VALTOWN_TOKEN=<value:string>", "Valtown API token env var.", {
    prefix: "VALTOWN_",
    required: true,
  })
  .action(() => {
    rootCmd.showHelp();
  });

rootCmd
  .command("eval")
  .description("Eval an expression.")
  .arguments("<expression:string>")
  .action(async ({ token }, expression) => {
    const resp = await client["/v1/eval"].post({
      json: {
        code: expression,
      },
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (resp.status !== 200) {
      console.error(resp.statusText);
      Deno.exit(1);
    }

    const body = await resp.json();

    printAsJSON(body);
  });

rootCmd
  .command("run")
  .description("Run a val.")
  .arguments("<val:string> [args...]")
  .action(async ({ token }, val, ...args) => {
    const { author, name } = splitVal(val);

    let runArgs: string[] | null = null;
    if (!Deno.isatty(Deno.stdin.rid)) {
      const buffer = readAllSync(Deno.stdin);
      const content = new TextDecoder().decode(buffer);
      if (content) {
        if (args.length > 0) {
          console.error(
            "val input cannot be passed both through stdin and args"
          );
          Deno.exit(1);
        }
        runArgs = JSON.parse(content);
      }
    }

    if (!runArgs) {
      runArgs = args.map((arg) => {
        try {
          return JSON.parse(arg);
        } catch {
          return arg;
        }
      });
    }

    const resp = await client["/v1/run/{username}.{val_name}"].post({
      // @ts-ignore: path params extraction is broken
      params: {
        username: author,
        val_name: name,
      },
      headers: {
        Authorization: `Bearer ${token}`,
      },
      json: {
        args: runArgs,
      },
    });

    if (resp.status !== 200) {
      const res = await resp.json();
      console.error(res);
      Deno.exit(1);
    }

    const body = await resp.json();
    printAsJSON(body);
  });

rootCmd
  .command("edit")
  .description("Edit a val in the system editor.")
  .arguments("<val:string>")
  .action(async ({ token }, val) => {
    const { author, name } = splitVal(val);
    const getResp = await client["/v1/alias/{username}/{val_name}"].get({
      params: {
        username: author,
        val_name: name,
      },
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (getResp.status !== 200) {
      console.error(getResp.statusText);
      Deno.exit(1);
    }

    const { code, id: valID } = await getResp.json();
    if (!code || !valID) {
      console.error("invalid response");
      Deno.exit(1);
    }

    const edited = await editText(code, "ts");
    if (code === edited) {
      console.log("No changes.");
      return;
    }

    const updateResp = await client["/v1/vals/{val_id}/versions"].post({
      params: {
        val_id: valID,
      },
      headers: {
        Authorization: `Bearer ${token}`,
      },
      json: { code: edited },
    });

    if (updateResp.status !== 201) {
      console.error(updateResp.statusText);
      Deno.exit(1);
    }

    console.log("Updated!");
  });

rootCmd
  .command("view")
  .description("View val code.")
  .option("-w, --web", "View in browser")
  .option("--readme", "View readme")
  .option("--code", "View code")
  .option("--json", "View as JSON")
  .arguments("<val:string>")
  .action(async (flags, val) => {
    const { author, name } = splitVal(val);
    if (flags.web) {
      open(`https://val.town/v/${author}.${name}`);
      Deno.exit(0);
    }

    const resp = await client["/v1/alias/{username}/{val_name}"].get({
      params: {
        username: author,
        val_name: name,
      },
      headers: {
        Authorization: `Bearer ${flags.token}`,
      },
    });

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

    if (Deno.isatty(Deno.stdout.rid)) {
      // @ts-ignore: strange fets issue
      printCode("typescript", code);
    } else {
      console.log(JSON.stringify(body));
    }
  });

rootCmd
  .command("search")
  .description("Search vals.")
  .arguments("<query:string>")
  .action(async ({ token }, query) => {
    const resp = await client["/v1/search/vals"].get({
      query: {
        query: query,
        limit: 100,
      },
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const { data } = await resp.json();
    if (!data) {
      console.error("invalid response");
      Deno.exit(1);
    }
    const rows = data.map((val) => {
      const name = `${val.author?.username}.${val.name}`;
      const link = `https://val.town/v/${name.slice(1)}`;
      return [name, `v${val.version}`, link];
    });

    if (Deno.isatty(Deno.stdout.rid)) {
      const table = new Table(...rows).header(["name", "version", "link"]);
      table.render();
    } else {
      console.log(rows.map((row) => row.join("\t")).join("\n"));
    }
  });

rootCmd
  .command("api")
  .description("Make an API request.")
  .example("Get your user info", "vt api /v1/me")
  .arguments("<path:string>")
  .option("-X, --method <method:string>", "HTTP method.", { default: "GET" })
  .option("-d, --data <data:string>", "Request Body")
  .action(async ({ token, method, data }, path) => {
    if (!path.startsWith("/")) {
      path = `/${path}`;
    }
    if (!path.startsWith("/v1")) {
      path = `/v1${path}`;
    }

    const resp = await fetch(`${apiRoot}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: data,
    });

    if (resp.status != 200) {
      console.error(resp.statusText);
      Deno.exit(1);
    }

    printAsJSON(await resp.json());
  });

rootCmd
  .command("openapi")
  .description("View openapi specs")
  .hidden()
  .option("--web, -w", "Open in browser")
  .action(async ({ web }) => {
    if (web) {
      open("https://www.val.town/docs/openapi.html");
      Deno.exit(0);
    }

    const resp = await fetch("https://www.val.town/docs/openapi.yaml");
    if (resp.status != 200) {
      console.error(resp.statusText);
      Deno.exit(1);
    }

    printCode("yaml", await resp.text());
  });

rootCmd
  .command("token")
  .hidden()
  .action(({ token }) => {
    console.log(token);
  });

rootCmd.command("completions", new CompletionsCommand());

await rootCmd.parse();
