using System.Diagnostics;
using System.Formats.Nrbf;
using System.Globalization;
using System.Reflection.Metadata;
using System.Runtime.Serialization;
using System.Text;

namespace MyMyTools.NrbfDecoder;

/// <summary>
/// 解析失敗を利用者が原因特定できる日本語の複数行エラーへ変換する。
/// 型は生成せず、例外・読込位置・レコード種別・型名だけを報告する。
/// </summary>
internal static class Diagnostics
{
    /// <summary>診断用の再解析で許す型名node数。通常解析の既定値には使わない。</summary>
    internal const int DiagnosticTypeNameMaxNodes = 1024;
    private const int MaximumListedTypeNames = 10;
    private const int MaximumTypeNameCharacters = 400;
    private const int MaximumMessageCharacters = 1000;
    private static readonly TimeSpan DiagnosticRetryBudget = TimeSpan.FromSeconds(20);

    internal static int DefaultTypeNameMaxNodes { get; } = new TypeNameParseOptions().MaxNodes;

    internal static PayloadOptions ApplicationOptions() => new() { UndoTruncatedTypeNames = false };

    internal static string InvalidHeader(FileStream stream)
    {
        byte[] head = new byte[16];
        stream.Position = 0;
        int read = stream.ReadAtLeast(head, head.Length, throwOnEndOfStream: false);
        StringBuilder message = new("BinaryFormatter NRBFのヘッダーではありません。");
        message.Append("\n\n【詳細】");
        message.Append(CultureInfo.InvariantCulture,
            $"\n先頭{read}バイト: {Convert.ToHexString(head, 0, read)}");
        string? signature = DescribeSignature(head.AsSpan(0, read));
        if (signature is not null) message.Append("\n推定: ").Append(signature);
        return message.ToString();
    }

    internal static string DecodeFailure(FileInfo file, Exception exception, long position, Stopwatch stopwatch)
    {
        StringBuilder message = new(Headline(exception));
        message.Append("\n\n【詳細】");
        AppendException(message, exception);
        message.Append(CultureInfo.InvariantCulture,
            $"\n読込位置: 約 {position:N0} / {file.Length:N0} バイト");

        string? recordHint = DescribeUnsupportedRecord(exception);
        if (recordHint is not null) message.Append("\nレコード: ").Append(recordHint);

        if (exception is SerializationException)
        {
            message.Append("\n診断: ");
            message.Append(stopwatch.Elapsed < DiagnosticRetryBudget
                ? DiagnoseWithRelaxedTypeNames(file)
                : "解析に時間がかかったため、型名上限を緩めた再解析は省略しました。");
        }
        return message.ToString();
    }

    internal static void AppendException(StringBuilder message, Exception exception)
    {
        message.Append("\n例外: ").Append(Describe(exception));
        Exception? inner = exception.InnerException;
        for (int depth = 0; inner is not null && depth < 3; depth++, inner = inner.InnerException)
            message.Append("\n内部例外: ").Append(Describe(inner));
    }

    internal static string Describe(Exception exception) =>
        $"{exception.GetType().FullName}: {Limit(exception.Message, MaximumMessageCharacters)}";

    private static string Headline(Exception exception) => exception switch
    {
        EndOfStreamException =>
            "NRBFデータが途中で終わっています。ファイルが切り詰められているか、書込み途中の可能性があります。",
        DecoderFallbackException => "NRBFデータ内の文字列が不正なUTF-8です。",
        NotSupportedException => "対応していないNRBF形式です。",
        SerializationException => "NRBFデータを解析できません。",
        IOException or UnauthorizedAccessException => "ファイルを読み込めません。",
        _ => "NRBFデコーダーで予期しないエラーが発生しました。",
    };

    /// <summary>
    /// 既定の型名上限で失敗したpayloadを、上限を緩めて一度だけ読み直す。結果treeは返さず、
    /// どの型名が上限を超えたかだけを報告する。sidecar自体の入力・時間上限はそのまま効く。
    /// </summary>
    private static string DiagnoseWithRelaxedTypeNames(FileInfo file)
    {
        PayloadOptions relaxed = new()
        {
            UndoTruncatedTypeNames = true,
            TypeNameParseOptions = new TypeNameParseOptions { MaxNodes = DiagnosticTypeNameMaxNodes },
        };
        using FileStream stream = file.OpenRead();
        IReadOnlyDictionary<SerializationRecordId, SerializationRecord> records;
        try
        {
            global::System.Formats.Nrbf.NrbfDecoder.Decode(stream, out records, relaxed, leaveOpen: true);
        }
        catch (Exception exception) when (exception is not OutOfMemoryException)
        {
            return string.Create(CultureInfo.InvariantCulture,
                $"型名の上限（{DiagnosticTypeNameMaxNodes}）を緩めても解析できません。{Describe(exception)}（読込位置 約 {SafePosition(stream):N0} バイト）");
        }

        List<(string Name, int Nodes)> complex = records.Values
            .Select(TryGetTypeName)
            .OfType<TypeName>()
            .Select(name => (Name: name.AssemblyQualifiedName, Nodes: name.GetNodeCount()))
            .Where(entry => entry.Nodes > DefaultTypeNameMaxNodes)
            .DistinctBy(entry => entry.Name, StringComparer.Ordinal)
            .OrderByDescending(entry => entry.Nodes)
            .ToList();
        if (complex.Count == 0)
        {
            return "型名の上限を緩め、.NET Frameworkが切り詰めて書き込んだ型名の復元を有効にすると解析できました。"
                + "切り詰められた型名（ジェネリック型引数を含む型）が原因の可能性があります。";
        }

        StringBuilder message = new(string.Create(CultureInfo.InvariantCulture,
            $"型名の複雑さが既定上限（{DefaultTypeNameMaxNodes}）を超えています。上限を緩めると解析できました。該当する型名 {complex.Count}件:"));
        foreach ((string name, int nodes) in complex.Take(MaximumListedTypeNames))
            message.Append(CultureInfo.InvariantCulture, $"\n  - 複雑さ {nodes}: {Limit(name, MaximumTypeNameCharacters)}");
        if (complex.Count > MaximumListedTypeNames)
            message.Append(CultureInfo.InvariantCulture, $"\n  - ほか {complex.Count - MaximumListedTypeNames}件");
        return message.ToString();
    }

    private static TypeName? TryGetTypeName(SerializationRecord record)
    {
        if (record is not (ClassRecord or ArrayRecord)) return null;
        try
        {
            return record.TypeName;
        }
        catch (Exception exception) when (exception is not OutOfMemoryException)
        {
            return null;
        }
    }

    private static string? DescribeUnsupportedRecord(Exception exception)
    {
        if (exception is not NotSupportedException) return null;
        // 10.0.11 は "<数値> Record Type is not supported by design." を返す。
        string text = exception.Message;
        int digits = 0;
        while (digits < text.Length && char.IsAsciiDigit(text[digits])) digits++;
        if (digits == 0 || !text.AsSpan(digits).StartsWith(" Record Type", StringComparison.Ordinal)
            || !int.TryParse(text.AsSpan(0, digits), NumberStyles.None, CultureInfo.InvariantCulture, out int value))
            return null;
        SerializationRecordType recordType = (SerializationRecordType)value;
        string hint = recordType switch
        {
            SerializationRecordType.ClassWithMembers or SerializationRecordType.SystemClassWithMembers =>
                "メンバー型情報なしで保存されています（FormatterTypeStyle.TypesAlways以外の設定）。",
            SerializationRecordType.MethodCall or SerializationRecordType.MethodReturn =>
                ".NET Remotingのメソッド呼び出しデータです。",
            _ => "このレコード種別は System.Formats.Nrbf が対応していません。",
        };
        return string.Create(CultureInfo.InvariantCulture, $"{recordType} ({value}) — {hint}");
    }

    private static string? DescribeSignature(ReadOnlySpan<byte> head) => head switch
    {
        [0x1F, 0x8B, ..] => "gzip圧縮データ",
        [0x50, 0x4B, 0x03, 0x04, ..] => "ZIPアーカイブ",
        [0x78, 0x01 or 0x5E or 0x9C or 0xDA, ..] => "zlib圧縮データ",
        [0x28, 0xB5, 0x2F, 0xFD, ..] => "Zstandard圧縮データ",
        [0xEF, 0xBB, 0xBF, ..] or [(byte)'<', ..] or [(byte)'{', ..] => "テキスト（XML / JSON等）",
        _ => null,
    };

    internal static long SafePosition(Stream stream)
    {
        try
        {
            return stream.Position;
        }
        catch (Exception exception) when (exception is IOException or ObjectDisposedException or NotSupportedException)
        {
            return -1;
        }
    }

    internal static string Limit(string value, int maximumCharacters) =>
        value.Length <= maximumCharacters ? value : string.Concat(value.AsSpan(0, maximumCharacters), "…");
}
