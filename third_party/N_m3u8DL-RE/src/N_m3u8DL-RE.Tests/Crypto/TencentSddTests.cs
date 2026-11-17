using N_m3u8DL_RE.Crypto;

namespace N_m3u8DL_RE.Tests.Crypto;

public class TencentSddTests
{
    private static byte[] Key => Enumerable.Range(0,32).Select(i=>(byte)i).ToArray();
    private static byte[] Nonce => Enumerable.Range(0,12).Select(i=>(byte)i).ToArray();

    [Theory]
    [InlineData(0UL,"15c43013b010dc94eb8919b79e56295835c6df2ab1898ff72116c5e432f3e06466d9c6e115a50c4ddec2a590f1b6ad944d17db4243a253d21fd260811e3bb999")]
    [InlineData(1UL,"712113056dd82a4474357086a6cdc74d8192add78eb3c218d472b7fc560738284bfd8053ef4bce4f7e1c830957341781ad4a3efd10e6ae15834865354940ccef")]
    [InlineData(3UL,"0ef9fb807bb75ae8637d730a68bda920db840b373589a2f8e9d9871725123e09d95d3ef7c827db90cadfe00441c0fa45c82ae0f57228f16a908be6b363f7aaec")]
    [InlineData(4294967295UL,"e717d3fb9469d4518aa55a2ab8d7b30ba7cd8888d6e6da83758f785352ae571b6c9d4d501e37ba1db66c504972a261259fbdc1f80c0ddbc5de0fe3bfc6e1f08b")]
    [InlineData(4294967296UL,"9af7e1be5251bbf6caa66dc0d08375c10d7a439044d82f664c6c5db0504574aee1debe2119767707281f59a9d02e823a5c46248bbeaa860ec8677269790a8237")]
    public void NativeV2Oracle(ulong counter,string expected) =>
        Assert.Equal(Convert.FromHexString(expected),TencentChaChaV2.Block(Key,Nonce,counter));

    [Fact]
    public void SparseNalDoesNotDoubleEscapePlaintextOrDecryptShortTail()
    {
        byte[] plain = Enumerable.Repeat((byte)0x55,350).ToArray(); plain[0]=2;plain[1]=1;
        // Existing plaintext escape must survive byte-for-byte.
        plain[150]=0;plain[151]=0;plain[152]=3;plain[153]=1;
        var encrypted=(byte[])plain.Clone();
        TencentChaChaV2.Crypt(encrypted.AsSpan(48,64),Key,Nonce,48);
        TencentChaChaV2.Crypt(encrypted.AsSpan(240,64),Key,Nonce,240);
        var input=new byte[]{0,0,0,1}.Concat(Escape(encrypted)).ToArray();
        var decoded=new List<byte>();
        TencentSdd.RestoreAnnexB(input,Key,Nonce,(_,b)=>decoded.Add(b));
        Assert.Equal(new byte[]{0,0,0,1}.Concat(plain),decoded);
    }

    private static byte[] Escape(byte[] input)
    {
        var b=new List<byte>();int zeros=0;
        foreach(byte v in input) {if(zeros>=2 && v<=3){b.Add(3);zeros=0;}b.Add(v);zeros=v==0?zeros+1:0;}
        return b.ToArray();
    }

    [Fact]
    public void UnsupportedContainerAndBadMaterialFail()
    {
        Assert.Throws<InvalidDataException>(()=>TencentSdd.RestoreTransport(new byte[188],Key,Nonce));
        Assert.Throws<InvalidDataException>(()=>TencentSdd.Decrypt([],new byte[32],Nonce));
    }

    [Fact]
    public void SeparateAudioKeepsOuterDecodedBytes()
    {
        byte[] pat=[0,0xb0,13,0,1,0xc1,0,0,0,1,0xf0,0,0,0,0,0];
        byte[] pmt=[2,0xb0,18,0,1,0xc1,0,0,0xe1,1,0xf0,0,0x0f,0xe1,1,0xf0,0,0,0,0,0];
        var ts=Packetize(0,new byte[]{0}.Concat(pat).ToArray())
            .Concat(Packetize(4096,new byte[]{0}.Concat(pmt).ToArray()))
            .Concat(Packetize(257,Enumerable.Repeat((byte)0x71,400).ToArray())).SelectMany(p=>p).ToArray();
        Assert.Equal(ts,TencentSdd.RestoreTransport(ts,Key,Nonce));
    }

    [Theory]
    [InlineData(false,false)]
    [InlineData(true,false)]
    [InlineData(true,true)]
    public void TransportPreservesAudioTimestampsPcrAndNalAcrossPesBoundary(bool privatePmt,bool splitPmt)
    {
        byte[] plain=Enumerable.Repeat((byte)0x55,1100).ToArray();plain[0]=2;plain[1]=1;
        plain[150]=0;plain[151]=0;plain[152]=3;plain[153]=1;
        var encrypted=(byte[])plain.Clone();
        for(int off=48;off<=encrypted.Length-64;off+=192) TencentChaChaV2.Crypt(encrypted.AsSpan(off,64),Key,Nonce,(ulong)off);
        byte[] annex=new byte[]{0,0,0,1}.Concat(Escape(encrypted)).ToArray();
        // PAT -> PMT PID 4096 -> HEVC PID 256, AAC PID 257.
        byte[] pat=[0,0xb0,13,0,1,0xc1,0,0,0,1,0xf0,0,0,0,0,0];
        byte[] pmt=[2,0xb0,23,0,1,0xc1,0,0,0xe1,0,0xf0,0,0x24,0xe1,0,0xf0,0,0x0f,0xe1,1,0xf0,0,0,0,0,0];
        if(privatePmt) pmt=[2,0xb0,29,0,1,0xc1,0,0,0xe1,0,0xf0,0,0xc0,0xe1,0,0xf0,6,0x0f,4,0x74,0x76,0x66,0x32,0x0f,0xe1,1,0xf0,0,0,0,0,0];
        byte[] head=[0,0,1,0xe0,0,0,0x80,0x80,5,0x21,0,1,0,1];
        var before=new List<byte[]>();
        before.AddRange(Packetize(0,new byte[]{0}.Concat(pat).ToArray()));
        if(splitPmt)
        {
            before.AddRange(Packetize(4096,new byte[]{0}.Concat(pmt[..14]).ToArray()));
            var continuation=Packetize(4096,pmt[14..]);continuation[0][1]&=0xbf;
            before.AddRange(continuation);
        }
        else before.AddRange(Packetize(4096,new byte[]{0}.Concat(pmt).ToArray()));
        var part1=Packetize(256,head.Concat(annex[..90]).ToArray(),pcr:true);
        var part2=Packetize(256,head.Concat(annex[90..]).ToArray());
        var audio=Packetize(257,Enumerable.Repeat((byte)0x71,300).ToArray());
        before.AddRange(part1);before.AddRange(audio);before.AddRange(part2);
        var output=TencentSdd.RestoreTransport(before.SelectMany(p=>p).ToArray(),Key,Nonce);
        var after=Enumerable.Range(0,output.Length/188).Select(i=>output.AsSpan(i*188,188).ToArray()).ToArray();
        int Pid(byte[] p)=>((p[1]&31)<<8)|p[2];
        int Offset(byte[] p)=>(p[3]&16)==0?188:(p[3]&32)!=0?5+p[4]:4;
        if(privatePmt)
        {
            byte[] section=after.Where(p=>Pid(p)==4096).SelectMany(p=>p.Skip(Offset(p)+((p[1]&64)!=0?1:0))).Take(pmt.Length).ToArray();
            Assert.Equal(0x24,section[12]);
            uint crc=uint.MaxValue;
            foreach(byte value in section){crc^=(uint)value<<24;for(int bit=0;bit<8;bit++)crc=(crc<<1)^((crc&0x80000000)!=0?0x04c11db7u:0);}
            Assert.Equal(0u,crc);
        }
        Assert.Equal(audio.SelectMany(p=>p),after.Where(p=>Pid(p)==257).SelectMany(p=>p));
        var video=after.Where(p=>Pid(p)==256).ToArray();
        // PCR and random-access flags stay in their original adaptation field.
        Assert.Equal(part1[0].AsSpan(6,6).ToArray(),video[0].AsSpan(6,6).ToArray());
        Assert.True((video[0][5]&0x90)==0x90);
        var es=new List<byte>();var current=new List<byte>();int pesCount=0;
        void Finish()
        {
            if(current.Count==0)return;
            Assert.Equal(head,current.Take(head.Length));pesCount++;
            es.AddRange(current.Skip(head.Length));current.Clear();
        }
        int? last=null;
        foreach(var p in video)
        {
            int off=Offset(p);if(off==188)continue;
            if(last!=null)Assert.Equal((last.Value+1)&15,p[3]&15);last=p[3]&15;
            if((p[1]&64)!=0)Finish();current.AddRange(p.Skip(off));
        }
        Finish();Assert.Equal(2,pesCount);
        Assert.Equal(new byte[]{0,0,0,1}.Concat(plain),es);
    }

    private static List<byte[]> Packetize(int pid,byte[] body,bool pcr=false)
    {
        var result=new List<byte[]>();int pos=0,cc=0;
        while(pos<body.Length)
        {
            bool clock=pcr && pos==0;
            int take=Math.Min(clock?176:184,body.Length-pos),padding=184-take;
            var p=Enumerable.Repeat((byte)255,188).ToArray();p[0]=0x47;
            p[1]=(byte)((pid>>8)|(pos==0?64:0));p[2]=(byte)pid;p[3]=(byte)(0x10|(cc++&15));
            if(padding>0){p[3]|=32;p[4]=(byte)(padding-1);if(padding>1)p[5]=(byte)(clock?0x50:0);}
            if(clock)new byte[]{1,2,3,4,5,6}.CopyTo(p,6);
            body.AsSpan(pos,take).CopyTo(p.AsSpan(188-take));pos+=take;result.Add(p);
        }
        return result;
    }
}
