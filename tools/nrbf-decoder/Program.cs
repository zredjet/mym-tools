using System.Formats.Nrbf;
using System.Runtime.Serialization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace MyMyTools.NrbfDecoder;

internal static class Program
{
    private const long MaximumInputBytes = 64L * 1024 * 1024;

    public static int Main(string[] args)
    {
        ProbeResult result;
        try
        {
            result = Probe(args);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            result = new(false, null, null, $"ファイルを読み込めません: {exception.Message}");
        }
        catch (Exception exception) when (exception is SerializationException or InvalidDataException)
        {
            result = new(false, null, null, $"NRBFデータを解析できません: {exception.Message}");
        }

        Console.Out.WriteLine(JsonSerializer.Serialize(result, NrbfJsonContext.Default.ProbeResult));
        return result.Ok ? 0 : 1;
    }

    private static ProbeResult Probe(string[] args)
    {
        if (args.Length != 2 || args[0] != "--probe")
        {
            return new(false, null, null, "使用方法: nrbf-decoder --probe <path>");
        }

        FileInfo file = new(args[1]);
        if (!file.Exists)
        {
            return new(false, null, null, "指定されたファイルがありません。");
        }

        if (file.Length > MaximumInputBytes)
        {
            return new(false, null, null, "ファイルサイズが64 MiBの上限を超えています。");
        }

        using FileStream stream = file.OpenRead();
        if (!global::System.Formats.Nrbf.NrbfDecoder.StartsWithPayloadHeader(stream))
        {
            return new(false, null, null, "BinaryFormatter NRBFのヘッダーではありません。");
        }

        SerializationRecord root = global::System.Formats.Nrbf.NrbfDecoder.Decode(stream);
        return new(true, root.RecordType.ToString(), root.TypeName?.FullName, null);
    }
}

internal sealed record ProbeResult(bool Ok, string? RecordType, string? RootType, string? Error);

[JsonSerializable(typeof(ProbeResult))]
internal sealed partial class NrbfJsonContext : JsonSerializerContext;
