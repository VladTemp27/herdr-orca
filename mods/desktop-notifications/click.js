// Run by Windows Script Host, not by Herdr: a toast's herdr-agent:<terminal> link, clicked.
// Like macOS's -activate and -execute: focuses that agent and brings Herdr's window forward.
// toast.ps1 registers it as the link's handler: wscript //B click.js <herdr-app.exe> <link>
var args = WScript.Arguments;
if (args.length === 2) {
  var terminal = String(args.Item(1)).replace(/^herdr-agent:(\/\/)?/i, "").replace(/\/$/, "");
  // Only an address (t3, or machine/t3) ever reaches the command line: any page can open such a link.
  if (/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$/.test(terminal)) {
    var shell = WScript.CreateObject("WScript.Shell");
    shell.Run('"' + args.Item(0) + '" do agent.focus --terminal ' + terminal, 0, true);
    // The click lets this process bring a window forward; Herdr's is titled "Herdr".
    shell.AppActivate("Herdr");
  }
}
