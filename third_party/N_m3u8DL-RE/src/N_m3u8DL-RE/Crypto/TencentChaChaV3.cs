using System.Buffers.Binary;
using System.Numerics;

namespace N_m3u8DL_RE.Crypto;

// Native ARM32 libDownloadProxy.so 0x2C2C84 / 0x2C2EB0.
// Independent native-oracle vectors cover 64-bit counter boundaries.
internal static class TencentChaChaV3
{
    public static byte[] Crypt(byte[] data, byte[] key, byte[] nonce, ulong offset = 0)
    {
        if (key.Length != 32 || nonce.Length != 12) throw new ArgumentException("Tencent V3 requires a 32-byte key and 12-byte nonce");
        var output = new byte[data.Length];
        for (int pos = 0; pos < data.Length;)
        {
            var stream = Block(key, nonce, offset / 64);
            int start = (int)(offset % 64), take = Math.Min(64 - start, data.Length - pos);
            for (int i = 0; i < take; i++) output[pos + i] = (byte)(data[pos + i] ^ stream[start + i]);
            pos += take;
            offset = checked(offset + (ulong)take);
        }
        return output;
    }

    internal static byte[] Block(byte[] key, byte[] nonce, ulong counter)
    {
        if (key.Length != 32 || nonce.Length != 12) throw new ArgumentException("Invalid Tencent V3 material");
        uint[] k = new uint[8], n = new uint[3];
        for (int i = 0; i < 8; i++) k[i] = BinaryPrimitives.ReadUInt32LittleEndian(key.AsSpan(i * 4));
        for (int i = 0; i < 3; i++) n[i] = BinaryPrimitives.ReadUInt32LittleEndian(nonce.AsSpan(i * 4));
        uint[] initial = [0x65278809, 0x74857523, k[1], k[4], k[2], 0x82626595,
            (uint)counter, k[6], k[5], k[0], k[3], n[1], n[2], n[0], (uint)(counter >> 32), k[7]];
        var x = (uint[])initial.Clone();
        for (int i = 0; i < 10; i++)
        {
            Quarter(x, 0,4,8,12); Quarter(x, 1,5,9,13); Quarter(x, 2,6,10,14); Quarter(x, 3,7,11,15);
            Quarter(x, 0,5,10,15); Quarter(x, 1,6,11,12); Quarter(x, 2,7,8,13); Quarter(x, 3,4,9,14);
        }
        var result = new byte[64];
        for (int i = 0; i < 16; i++) BinaryPrimitives.WriteUInt32LittleEndian(result.AsSpan(i * 4), unchecked(x[i] + initial[i]));
        return result;
    }

    private static void Quarter(uint[] x, int a, int b, int c, int d)
    {
        unchecked
        {
            x[a] -= x[b]; x[d] = BitOperations.RotateRight(x[d] ^ x[a], 16);
            x[c] -= x[d]; x[b] = BitOperations.RotateRight(x[b] ^ x[c], 20);
            x[a] += x[b]; x[d] = BitOperations.RotateRight(x[d] ^ x[a], 24);
            x[c] += x[d]; x[b] = BitOperations.RotateRight(x[b] ^ x[c], 26);
        }
    }
}
