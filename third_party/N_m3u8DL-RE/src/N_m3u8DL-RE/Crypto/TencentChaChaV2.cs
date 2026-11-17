using System.Buffers.Binary;
using System.Numerics;

namespace N_m3u8DL_RE.Crypto;

// libTPCore-tvideo.so ARM32 0x7DC904 / 0x7DCB80. Separate from SSE V3.
internal static class TencentChaChaV2
{
    internal static byte[] Block(byte[] key, byte[] nonce, ulong counter)
    {
        if (key.Length != 32 || nonce.Length != 12) throw new ArgumentException("Invalid Tencent SDD V2 material");
        uint[] k = new uint[8], n = new uint[3];
        for (int i = 0; i < 8; i++) k[i] = BinaryPrimitives.ReadUInt32LittleEndian(key.AsSpan(i * 4));
        for (int i = 0; i < 3; i++) n[i] = BinaryPrimitives.ReadUInt32LittleEndian(nonce.AsSpan(i * 4));
        uint[] initial = [1668363569, 2023044434, unchecked((uint)-2043074488), k[1], k[3], k[4],
            (uint)counter, k[7], k[2], k[0], k[6], n[0], n[1], n[2], (uint)(counter >> 32), k[5]];
        var x = (uint[])initial.Clone();
        for (int i = 0; i < 10; i++)
        {
            Quarter(x,0,4,8,12); Quarter(x,1,5,9,13); Quarter(x,2,6,10,14); Quarter(x,3,7,11,15);
            Quarter(x,0,5,10,15); Quarter(x,1,6,11,12); Quarter(x,2,7,8,13); Quarter(x,3,4,9,14);
        }
        var output = new byte[64];
        for (int i = 0; i < 16; i++) BinaryPrimitives.WriteUInt32LittleEndian(output.AsSpan(i * 4), unchecked(x[i] + initial[i]));
        return output;
    }

    internal static void Crypt(Span<byte> data, byte[] key, byte[] nonce, ulong offset)
    {
        for (int p = 0; p < data.Length;)
        {
            var stream = Block(key, nonce, offset / 64);
            int start = (int)(offset % 64), take = Math.Min(64 - start, data.Length - p);
            for (int i = 0; i < take; i++) data[p+i] ^= stream[start+i];
            offset = checked(offset + (ulong)take);
            p += take;
        }
    }

    private static void Quarter(uint[] x, int a, int b, int c, int d)
    {
        unchecked
        {
            x[a] -= x[b]; x[d] = BitOperations.RotateRight(x[d]^x[a],16);
            x[c] += x[d]; x[b] = BitOperations.RotateRight(x[b]^x[c],20);
            x[a] += x[b]; x[d] = BitOperations.RotateRight(x[d]^x[a],24);
            x[c] -= x[d]; x[b] = BitOperations.RotateRight(x[b]^x[c],26);
        }
    }
}
