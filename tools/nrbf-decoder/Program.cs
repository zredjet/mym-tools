using System.Text;
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
            response = InspectResponse.Failure("解析結果が256 MiBの出力上限を超えました。");
            output = JsonSerializer.SerializeToUtf8Bytes(response, NrbfJsonContext.Default.InspectResponse);
        }

        using Stream stdout = Console.OpenStandardOutput();
        stdout.Write(output);
        stdout.WriteByte((byte)'\n');
        return response.Ok ? 0 : 1;
    }

    private static InspectResponse Failure(string headline, Exception exception)
    {
        StringBuilder message = new(headline);
        message.Append("\n\n【詳細】");
        Diagnostics.AppendException(message, exception);
        return InspectResponse.Failure(message.ToString());
    }

    internal static InspectResponse InspectArgs(string[] args)
    {
        try
        {
            bool valid = args.Length is 2 or 3
                && args[0] == "--inspect"
                && (args.Length == 2 || args[2] == "--expand-byte-arrays");
            return valid
                ? Inspector.Inspect(args[1], expandByteArrays: args.Length == 3)
                : InspectResponse.Failure(
                    "使用方法: nrbf-decoder --inspect <path> [--expand-byte-arrays]");
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return Failure("ファイルを読み込めません。", exception);
        }
        catch (Exception exception) when (exception is not OutOfMemoryException)
        {
            return Failure("NRBFデコーダーで予期しないエラーが発生しました。", exception);
        }
    }
}
