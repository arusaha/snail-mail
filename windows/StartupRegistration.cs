using System;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Xml.Linq;

// Uses Windows' persisted task as the setting; no second preference to drift.
internal sealed class StartupRegistration
{
    internal const string DefaultTaskName = "Snail Mail local server";
    private readonly string root, node, executable, taskName;
    private static readonly XNamespace ns = "http://schemas.microsoft.com/windows/2004/02/mit/task";

    internal StartupRegistration(string root, string node, string executable, string taskName = DefaultTaskName)
    {
        this.root = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
        this.node = node;
        this.executable = Path.GetFullPath(executable);
        this.taskName = taskName;
    }

    internal static string QuoteArgument(string value)
    {
        var quoted = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { slashes++; continue; }
            quoted.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            quoted.Append(c);
            slashes = 0;
        }
        quoted.Append('\\', slashes * 2);
        return quoted.Append('"').ToString();
    }
    private static string UserSid(string user)
    {
        if (user.StartsWith("S-1-", StringComparison.OrdinalIgnoreCase)) return user;
        return new NTAccount(user).Translate(typeof(SecurityIdentifier)).Value;
    }
    private static void Release(object value)
    {
        if (value != null && Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value);
    }
    private dynamic GetTask(dynamic folder)
    {
        try { return folder.GetTask(taskName); }
        catch (Exception ex)
        {
            if (ex.HResult == unchecked((int)0x80070002)) return null;
            throw;
        }
    }
    private void VerifyOwner(dynamic task, string sid)
    {
        var xml = XDocument.Parse((string)task.Xml);
        var actions = xml.Root.Element(ns + "Actions").Elements().ToArray();
        var principals = xml.Root.Element(ns + "Principals").Elements().ToArray();
        if (actions.Length != 1 || actions[0].Name != ns + "Exec" || principals.Length != 1 ||
            !String.Equals((string)actions[0].Element(ns + "Command"), executable, StringComparison.OrdinalIgnoreCase) ||
            !((string)actions[0].Element(ns + "Arguments") ?? "").StartsWith(
                "--root " + QuoteArgument(root) + " --node ", StringComparison.OrdinalIgnoreCase) ||
            UserSid((string)principals[0].Element(ns + "UserId") ?? "") != sid)
            throw new InvalidOperationException("The startup task belongs to another installation or Windows user. It was not changed.");
    }
    private bool IsEnabled(dynamic task, string sid)
    {
        if (task == null || !(bool)task.Enabled) return false;
        var xml = XDocument.Parse((string)task.Xml);
        var triggers = xml.Root.Element(ns + "Triggers");
        return triggers != null && triggers.Elements(ns + "LogonTrigger").Any(t =>
            (string)t.Element(ns + "Enabled") != "false" &&
            UserSid((string)t.Element(ns + "UserId") ?? "") == sid);
    }
    private static string ResolveNode(string value)
    {
        if (Path.IsPathRooted(value) && File.Exists(value)) return Path.GetFullPath(value);
        foreach (string directory in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator))
        {
            if (String.IsNullOrWhiteSpace(directory)) continue;
            string candidate = Path.Combine(directory.Trim('"'), value);
            if (File.Exists(candidate)) return Path.GetFullPath(candidate);
        }
        throw new FileNotFoundException("Node.js could not be found. Start the tray from its desktop shortcut and retry.");
    }
    private string Definition(string sid)
    {
        if (!File.Exists(executable)) throw new FileNotFoundException("The tray executable is missing.");
        return new XDocument(new XElement(ns + "Task", new XAttribute("version", "1.2"),
            new XElement(ns + "RegistrationInfo", new XElement(ns + "Description", "Snail Mail system tray and hidden local server.")),
            new XElement(ns + "Triggers", new XElement(ns + "LogonTrigger",
                new XElement(ns + "Enabled", true), new XElement(ns + "UserId", sid))),
            new XElement(ns + "Principals", new XElement(ns + "Principal", new XAttribute("id", "Author"),
                new XElement(ns + "UserId", sid), new XElement(ns + "LogonType", "InteractiveToken"),
                new XElement(ns + "RunLevel", "LeastPrivilege"))),
            new XElement(ns + "Settings",
                new XElement(ns + "MultipleInstancesPolicy", "IgnoreNew"),
                new XElement(ns + "DisallowStartIfOnBatteries", false),
                new XElement(ns + "StopIfGoingOnBatteries", false),
                new XElement(ns + "Enabled", true), new XElement(ns + "ExecutionTimeLimit", "PT0S"),
                new XElement(ns + "RestartOnFailure", new XElement(ns + "Interval", "PT1M"), new XElement(ns + "Count", 3))),
            new XElement(ns + "Actions", new XAttribute("Context", "Author"), new XElement(ns + "Exec",
                new XElement(ns + "Command", executable),
                new XElement(ns + "Arguments", "--root " + QuoteArgument(root) + " --node " + QuoteArgument(ResolveNode(node))),
                new XElement(ns + "WorkingDirectory", root))))).ToString();
    }
    internal bool Apply(string action)
    {
        if (action != "status" && action != "enable" && action != "disable") throw new ArgumentException("Unknown startup action.");
        dynamic service = null, folder = null, task = null;
        using (var identity = WindowsIdentity.GetCurrent())
        try
        {
            string sid = identity.User.Value;
            service = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service", true));
            service.Connect();
            folder = service.GetFolder(@"\");
            task = GetTask(folder);
            if (task != null) VerifyOwner(task, sid);
            if (action == "enable")
            {
                Release(task); task = null;
                // TASK_CREATE_OR_UPDATE=6, TASK_LOGON_INTERACTIVE_TOKEN=3.
                task = folder.RegisterTask(taskName, Definition(sid), 6, sid, null, 3, null);
            }
            else if (action == "disable" && task != null) task.Enabled = false;
            Release(task); task = null;
            task = GetTask(folder);
            if (task != null) VerifyOwner(task, sid);
            bool enabled = IsEnabled(task, sid);
            if ((action == "enable" && !enabled) || (action == "disable" && enabled))
                throw new IOException("Windows did not persist the requested startup setting.");
            return enabled;
        }
        finally { Release(task); Release(folder); Release(service); }
    }
}
