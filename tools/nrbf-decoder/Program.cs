using System.Runtime.Serialization;
using System.Text.Json;

namespace MyMyTools.NrbfDecoder;

internal static class Program
{
    public static int Main(string[] args)
    {
        InspectResponse response = InspectArgs(args);

        byte[] output = JsonSerializer.SerializeToUtf8Bytes(response, NrbfJsonContext.Default.InspectResponse);
        if (output.LongLength > Inspector.MaximumProtocolBytes)
        {
            response = InspectResponse.Failure("解析結果が64 MiBの出力上限を超えました。");
            output = JsonSerializer.SerializeToUtf8Bytes(response, NrbfJsonContext.Default.InspectResponse);
        }

        using Stream stdout = Console.OpenStandardOutput();
        stdout.Write(output);
        stdout.WriteByte((byte)'\n');
        return response.Ok ? 0 : 1;
    }

    internal static InspectResponse InspectArgs(string[] args)
    {
        try
        {
            return args.Length == 2 && args[0] == "--inspect"
                ? Inspector.Inspect(args[1])
                : InspectResponse.Failure("使用方法: nrbf-decoder --inspect <path>");
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return InspectResponse.Failure($"ファイルを読み込めません: {exception.Message}");
        }
        catch (Exception exception) when (exception is SerializationException or InvalidDataException)
        {
            return InspectResponse.Failure($"NRBFデータを解析できません: {exception.Message}");
        }
        catch (Exception exception) when (exception is NotSupportedException or ArgumentException)
        {
            return InspectResponse.Failure($"対応していないNRBF形式です: {exception.Message}");
        }
        catch (Exception exception)
        {
            return InspectResponse.Failure($"NRBFデコーダーで予期しないエラーが発生しました: {exception.Message}");
        }
    }
}
